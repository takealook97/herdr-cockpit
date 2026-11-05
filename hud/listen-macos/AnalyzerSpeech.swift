import Foundation
import AVFoundation
import Speech

// All conversion and continuation writes are serialized, including end-of-input.
// Keep this type availability-gated; Listener retains it through closures only.
// Mutable conversion state belongs to queue, transcript to resultTask, and callbacks
// and task handles to the main lifecycle queue. No mutable state crosses owners.
@available(macOS 26, *)
final class AnalyzerSpeech: @unchecked Sendable {
    typealias Segment = (text: String, start: Double, duration: Double)
    let transcriber: SpeechTranscriber
    let analyzer: SpeechAnalyzer
    let format: AVAudioFormat
    let stream: AsyncStream<AnalyzerInput>
    let continuation: AsyncStream<AnalyzerInput>.Continuation
    let queue = DispatchQueue(label: "herdr-listen.speech-conversion")
    var converter: AVAudioConverter?
    var closed = false
    var resultTask: Task<Void, Never>?
    var analysisTask: Task<Void, Never>?
    var transcript = AnalyzerTranscript()
    var onResult: ((String, [Segment]) -> Void)?
    var onFinish: ((Error?) -> Void)?

    private init(transcriber: SpeechTranscriber, format: AVAudioFormat) {
        self.transcriber = transcriber
        self.format = format
        analyzer = SpeechAnalyzer(modules: [transcriber])
        var continuation: AsyncStream<AnalyzerInput>.Continuation!
        stream = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    static func prepare(locale: String, hints: [String]) async throws -> AnalyzerSpeech? {
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: locale)) else { return nil }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [],
                                           reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
        if await AssetInventory.status(forModules: [transcriber]) != .installed,
           let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        try Task.checkCancellation()
        guard await AssetInventory.status(forModules: [transcriber]) == .installed,
              let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { return nil }
        let driver = AnalyzerSpeech(transcriber: transcriber, format: format)
        let context = AnalysisContext()
        context.contextualStrings[.general] = hints
        try await driver.analyzer.setContext(context)
        try await driver.analyzer.prepareToAnalyze(in: format)
        return driver
    }

    func start() {
        resultTask = Task {
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    let segments: [Segment] = result.text.runs.map { run in
                        let range = run.audioTimeRange ?? result.range
                        return (String(result.text[run.range].characters), CMTimeGetSeconds(range.start), CMTimeGetSeconds(range.duration))
                    }
                    transcript.observe(text: text, segments: segments, isFinal: result.isFinal)
                    let combined = transcript.text
                    let allSegments = transcript.segments
                    DispatchQueue.main.async { self.onResult?(combined, allSegments) }
                }
                DispatchQueue.main.async { self.onFinish?(nil) }
            } catch {
                DispatchQueue.main.async { self.onFinish?(error) }
            }
        }
        analysisTask = Task {
            do {
                _ = try await analyzer.analyzeSequence(stream)
                try await analyzer.finalizeAndFinishThroughEndOfInput()
            } catch {
                DispatchQueue.main.async { self.onFinish?(error) }
            }
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let copy = Listener.copyBuffer(buffer) else { return }
        queue.async {
            guard !self.closed else { return }
            do {
                if copy.format == self.format { self.continuation.yield(AnalyzerInput(buffer: copy)); return }
                if self.converter == nil { self.converter = AVAudioConverter(from: copy.format, to: self.format) }
                guard let converter = self.converter else { throw ListenError.message("Unsupported analyzer audio format") }
                let capacity = AVAudioFrameCount(ceil(Double(copy.frameLength) * self.format.sampleRate / copy.format.sampleRate)) + 32
                guard let output = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: capacity) else { return }
                var supplied = false
                var error: NSError?
                let status = converter.convert(to: output, error: &error) { _, state in
                    if supplied { state.pointee = .noDataNow; return nil }
                    supplied = true
                    state.pointee = .haveData
                    return copy
                }
                if status == .error { throw error ?? NSError(domain: "herdr-listen", code: 1, userInfo: [NSLocalizedDescriptionKey: "Analyzer audio conversion failed"]) }
                if output.frameLength > 0 { self.continuation.yield(AnalyzerInput(buffer: output)) }
            } catch {
                DispatchQueue.main.async { self.onFinish?(error) }
            }
        }
    }

    func finish() {
        queue.async {
            guard !self.closed else { return }
            self.closed = true
            // Flush resampler latency so the final phoneme is not lost.
            if let converter = self.converter {
                while let output = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: 4096) {
                    var error: NSError?
                    let status = converter.convert(to: output, error: &error) { _, state in
                        state.pointee = .endOfStream
                        return nil
                    }
                    if output.frameLength > 0 { self.continuation.yield(AnalyzerInput(buffer: output)) }
                    if status == .endOfStream || status == .error || output.frameLength == 0 { break }
                }
            }
            self.continuation.finish()
        }
    }

    func cancel() {
        finish()
        resultTask?.cancel()
        analysisTask?.cancel()
        Task { await analyzer.cancelAndFinishNow() }
    }
}
