import Foundation
import AVFoundation
import Speech
import SoundAnalysis
import Darwin

struct Options {
    var statePath: String
    var locale = "ko-KR"
    var maxSeconds = 30.0
    var silence = 1.2
    var laughThreshold = 0.5
    var laughFilter = true
    var file: String?
    var explicitState = false

    init() throws {
        let env = ProcessInfo.processInfo.environment
        let cache = env["XDG_CACHE_HOME"].flatMap { $0.isEmpty ? nil : $0 }
            ?? (NSHomeDirectory() + "/.cache")
        statePath = cache + "/herdr-hud/listen.json"
        var args = CommandLine.arguments.dropFirst().makeIterator()
        while let flag = args.next() {
            if flag == "--help" || flag == "-h" {
                print("Usage: herdr-listen [--state PATH] [--locale ko-KR] [--max-seconds 30] [--silence 1.2] [--laugh-threshold 0..1] [--no-laugh-filter] [--file AUDIO]")
                exit(0)
            }
            if flag == "--no-laugh-filter" { laughFilter = false; continue }
            guard ["--state", "--locale", "--max-seconds", "--silence", "--laugh-threshold", "--file"].contains(flag),
                  let value = args.next(), !value.isEmpty else {
                throw ListenError.message("Invalid argument: \(flag)")
            }
            switch flag {
            case "--state": statePath = value; explicitState = true
            case "--locale": locale = value
            case "--file": file = value
            case "--laugh-threshold":
                guard let score = Double(value), score.isFinite, (0...1).contains(score) else {
                    throw ListenError.message("--laugh-threshold must be between 0 and 1")
                }
                laughThreshold = score
            default:
                guard let seconds = Double(value), seconds.isFinite, seconds > 0 else {
                    throw ListenError.message("\(flag) must be a positive number")
                }
                if flag == "--silence" { silence = seconds } else { maxSeconds = seconds }
            }
        }
    }
}

enum ListenError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case let .message(text): return text }
    }
}

struct ListenState: Encodable {
    var state = "idle"
    var level = 0.0
    var partial = ""
    var final = ""
    var error = ""
    var laughing = false
    var trimmed = 0
    let pid = getpid()
}

// SoundAnalysis may deliver callbacks off the caller's queue. Protect the pure
// tracker, then publish immutable snapshots to the main lifecycle queue.
final class LaughObserver: NSObject, SNResultsObserving {
    let tracker: LaughTracker
    let identifiers: Set<String>
    let lock = NSLock()
    var update: (([LaughRange], Bool, Double) -> Void)?
    var ended: (() -> Void)?

    init(threshold: Double, identifiers: Set<String>) {
        tracker = LaughTracker(threshold: threshold)
        self.identifiers = identifiers
    }
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        let score = result.classifications.filter { identifiers.contains($0.identifier) }.map(\.confidence).max() ?? 0
        let start = CMTimeGetSeconds(result.timeRange.start)
        let end = CMTimeGetSeconds(CMTimeRangeGetEnd(result.timeRange))
        lock.lock()
        tracker.observe(windowStart: start, windowEnd: end, score: score)
        let ranges = tracker.ranges, laughing = tracker.isLaughing
        lock.unlock()
        update?(ranges, laughing, end)
    }
    func request(_ request: SNRequest, didFailWithError error: Error) { ended?() }
    func requestDidComplete(_ request: SNRequest) { ended?() }
}

// Audio capture, SoundAnalysis and the main lifecycle each have a serial queue.
final class Listener {
    let options: Options
    let stateURL: URL
    var state = ListenState()
    var lastWrite = -Double.infinity
    var dirty = false
    var signals: [DispatchSourceSignal] = []
    var timer: DispatchSourceTimer?
    var recognizer: SFSpeechRecognizer?
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    let engine = AVAudioEngine()
    let analysisQueue = DispatchQueue(label: "herdr-listen.sound-analysis")
    var analyzer: SNAudioStreamAnalyzer?
    var fileAnalyzer: SNAudioFileAnalyzer?
    var observer: LaughObserver?
    var analysisFinished = true
    var analysisClosing = false
    var recognitionFinished = false
    var segments: [(text: String, start: Double, duration: Double)] = []
    var laughRanges: [LaughRange] = []
    var analyzedThrough = 0.0
    // Delay acoustic speech decisions until classified audio is available. Keeping
    // samples also lets the second weak prediction retract the first window.
    var loudSamples: [(start: Double, duration: Double)] = []
    var tapped = false
    var finishing = false
    var completed = false
    var heardSpeech = false
    var lastActivity = ProcessInfo.processInfo.systemUptime
    let started = ProcessInfo.processInfo.systemUptime
    let speechThreshold = 0.15

    init(_ options: Options) throws {
        self.options = options
        stateURL = URL(fileURLWithPath: options.statePath).standardizedFileURL
        guard options.file == nil || options.explicitState else { return }
        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    func write(immediate: Bool = false) {
        guard options.file == nil || options.explicitState else { return }
        dirty = true
        let now = ProcessInfo.processInfo.systemUptime
        guard immediate || now - lastWrite >= 0.1 else { return }
        let temporary = stateURL.deletingLastPathComponent()
            .appendingPathComponent(".listen-\(UUID().uuidString)")
        do {
            let data = try JSONEncoder().encode(state)
            // Create exclusively with restrictive permissions before writing text.
            let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            try file.write(contentsOf: data)
            try file.close()
            guard rename(temporary.path, stateURL.path) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            dirty = false
            lastWrite = now
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            fputs("herdr-listen: state write failed: \(error)\n", stderr)
            exit(1)
        }
    }

    func start() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { self.finish() }
            source.resume()
            signals.append(source)
        }
        // Permission prompts are part of an active session. Publish listening
        // now so polling clients do not mistake startup for a finished session.
        state.state = "listening"
        write(immediate: true)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(50))
        timer.setEventHandler {
            guard !self.completed else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if now - self.started >= self.options.maxSeconds ||
                (self.options.file == nil && self.heardSpeech &&
                 (self.observer == nil ? now - self.lastActivity : self.analyzedThrough - self.lastActivity) >= self.options.silence) {
                self.finish()
            }
            if self.dirty { self.write() }
        }
        timer.resume()
        self.timer = timer
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard !self.finishing, !self.completed else { return }
                guard status == .authorized else {
                    self.fail("음성 인식 권한이 필요합니다")
                    return
                }
                if self.options.file != nil { self.startAudio(); return }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard !self.finishing, !self.completed else { return }
                        guard granted else { self.fail("마이크 권한이 필요합니다"); return }
                        self.startAudio()
                    }
                }
            }
        }
    }

    func startAudio() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: options.locale)),
              recognizer.isAvailable else {
            fail("음성 인식을 사용할 수 없습니다 (\(options.locale))")
            return
        }
        // Never fall back to network speech recognition.
        guard recognizer.supportsOnDeviceRecognition else {
            fail("기기 내 음성 인식을 사용할 수 없습니다 (\(options.locale))")
            return
        }
        self.recognizer = recognizer
        if let path = options.file {
            let url = URL(fileURLWithPath: path)
            guard FileManager.default.isReadableFile(atPath: path) else { fail("오디오 파일을 읽을 수 없습니다"); return }
            let request = SFSpeechURLRecognitionRequest(url: url)
            configure(request)
            if let setup = makeClassifier() {
                do {
                    let analyzer = try SNAudioFileAnalyzer(url: url)
                    try analyzer.add(setup.0, withObserver: setup.1)
                    observer = setup.1
                    fileAnalyzer = analyzer
                    analysisFinished = false
                    analysisQueue.async {
                        analyzer.analyze()
                        DispatchQueue.main.async { self.analysisDidFinish() }
                    }
                } catch { /* Classification is optional; recognition still works. */ }
            }
            startRecognition(recognizer, request)
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        configure(request)
        self.request = request
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("마이크 입력을 사용할 수 없습니다")
            return
        }
        if let setup = makeClassifier() {
            do {
                let analyzer = SNAudioStreamAnalyzer(format: format)
                try analyzer.add(setup.0, withObserver: setup.1)
                self.analyzer = analyzer
                observer = setup.1
                analysisFinished = false
            } catch { /* Continue without laughter filtering if unavailable. */ }
        }
        // The tap is serial. Copy its borrowed PCM storage before queuing it;
        // AVAudioEngine can reuse the original buffer after this callback.
        var framePosition: AVAudioFramePosition = 0
        let analyzer = self.analyzer
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            let position = framePosition
            framePosition += AVAudioFramePosition(buffer.frameLength)
            if let analyzer, let copy = Self.copyBuffer(buffer) {
                self.analysisQueue.async { analyzer.analyze(copy, atAudioFramePosition: position) }
            }
            var sum = 0.0
            let count = Int(buffer.frameLength)
            if let channels = buffer.floatChannelData, count > 0 {
                for channel in 0..<Int(buffer.format.channelCount) {
                    for index in 0..<count {
                        let sample = Double(channels[channel][index])
                        sum += sample * sample
                    }
                }
            }
            let samples = max(1, count * Int(buffer.format.channelCount))
            let rms = sqrt(sum / Double(samples))
            let db = 20 * log10(max(rms, 0.0000001))
            let level = min(1, max(0, (db + 50) / 40))
            let start = Double(position) / format.sampleRate
            let duration = Double(count) / format.sampleRate
            DispatchQueue.main.async {
                guard !self.finishing, !self.completed else { return }
                self.state.level = level
                if level > self.speechThreshold {
                    if self.observer != nil {
                        self.loudSamples.append((start, duration))
                        self.refreshSpeechActivity()
                    } else if !self.state.laughing {
                        self.heardSpeech = true
                        self.lastActivity = ProcessInfo.processInfo.systemUptime
                    }
                }
                self.write()
            }
        }
        tapped = true
        startRecognition(recognizer, request)
        do {
            engine.prepare()
            try engine.start()
        } catch { fail("마이크를 시작할 수 없습니다: \(error.localizedDescription)") }
    }

    static func copyBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return nil }
        copy.frameLength = buffer.frameLength
        let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (src, dst) in zip(source, target) {
            if let srcData = src.mData, let dstData = dst.mData {
                memcpy(dstData, srcData, Int(src.mDataByteSize))
            }
        }
        return copy
    }

    func configure(_ request: SFSpeechRecognitionRequest) {
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
    }

    func makeClassifier() -> (SNClassifySoundRequest, LaughObserver)? {
        guard options.laughFilter else { return nil }
        do {
            let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
            var duration = 1.0
            switch request.windowDurationConstraint {
            case .durationRange(let range):
                duration = min(max(duration, CMTimeGetSeconds(range.start)), CMTimeGetSeconds(CMTimeRangeGetEnd(range)))
            case .enumeratedDurations(let durations):
                duration = durations.map { CMTimeGetSeconds($0) }.min(by: { abs($0 - 1) < abs($1 - 1) }) ?? duration
            @unknown default: break
            }
            request.windowDuration = CMTime(seconds: duration, preferredTimescale: 48_000)
            request.overlapFactor = 0.5
            let names: Set<String> = ["laughter", "giggling", "snicker", "belly_laugh", "chuckle_chortle", "baby_laughter"]
            let identifiers = names.intersection(request.knownClassifications)
            guard !identifiers.isEmpty else { return nil }
            let observer = LaughObserver(threshold: options.laughThreshold, identifiers: identifiers)
            observer.update = { ranges, laughing, end in
                DispatchQueue.main.async {
                    guard !self.completed else { return }
                    self.laughRanges = ranges
                    self.state.laughing = laughing
                    self.analyzedThrough = max(self.analyzedThrough, end)
                    self.refreshSpeechActivity()
                    self.refreshTranscript()
                    self.write()
                }
            }
            observer.ended = { DispatchQueue.main.async { self.analysisDidFinish() } }
            return (request, observer)
        } catch { return nil }
    }

    func refreshSpeechActivity() {
        guard observer != nil, options.file == nil else { return }
        let speech = loudSamples.filter {
            $0.start + $0.duration <= analyzedThrough &&
            keepSegment(start: $0.start, duration: $0.duration, ranges: laughRanges)
        }
        heardSpeech = !speech.isEmpty
        lastActivity = speech.last.map { $0.start + $0.duration } ?? 0
    }

    func refreshTranscript() {
        let trimmed = trimTranscript(segments: segments, ranges: laughRanges)
        state.partial = trimmed.text
        state.trimmed = trimmed.trimmed
    }

    func startRecognition(_ recognizer: SFSpeechRecognizer, _ request: SFSpeechRecognitionRequest) {
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                guard !self.completed, !self.recognitionFinished else { return }
                if let result {
                    let oldText = self.state.partial
                    self.segments = result.bestTranscription.segments.map { ($0.substring, $0.timestamp, $0.duration) }
                    self.refreshTranscript()
                    if self.observer == nil && !self.state.laughing && !self.state.partial.isEmpty && oldText != self.state.partial {
                        self.heardSpeech = true
                        self.lastActivity = ProcessInfo.processInfo.systemUptime
                    }
                    self.write()
                    if result.isFinal { self.complete(); return }
                }
                if let error {
                    if self.finishing { self.complete() }
                    else { self.fail("음성 인식 오류: \(error.localizedDescription)") }
                }
            }
        }
    }

    func stopAudio() {
        engine.stop()
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
    }

    func finish() {
        guard !finishing, !completed else { return }
        finishing = true
        stopAudio()
        request?.endAudio()
        // Give the on-device recognizer a bounded chance to deliver its final
        // transcript; retain the latest partial if it never sends a final result.
        if task == nil { complete(); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { self.complete() }
    }

    func complete() {
        guard !completed else { return }
        finishing = true
        recognitionFinished = true
        stopAudio()
        request?.endAudio()
        if let analyzer, !analysisClosing {
            analysisClosing = true
            analysisQueue.async { analyzer.completeAnalysis() }
        }
        finalizeIfReady()
    }

    func analysisDidFinish() {
        analysisFinished = true
        finalizeIfReady()
    }

    func finalizeIfReady() {
        guard !completed, recognitionFinished, analysisFinished else { return }
        completed = true
        task?.cancel()
        refreshTranscript()
        state.final = state.partial
        state.state = state.final.isEmpty ? "idle" : "final"
        state.level = 0
        write(immediate: true)
        printOfflineState()
        exit(0)
    }

    func printOfflineState() {
        if options.file != nil, let data = try? JSONEncoder().encode(state), let json = String(data: data, encoding: .utf8) {
            print(json)
        }
    }

    func fail(_ message: String) {
        guard !completed else { return }
        completed = true
        stopAudio()
        request?.endAudio()
        task?.cancel()
        state.state = "error"
        state.level = 0
        state.error = message
        write(immediate: true)
        printOfflineState()
        exit(1)
    }
}

do {
    let listener = try Listener(Options())
    listener.start()
    RunLoop.main.run()
} catch {
    fputs("herdr-listen: \(error)\n", stderr)
    exit(1)
}
