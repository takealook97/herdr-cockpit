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
    var keepAudio = 0
    var debugJSON = false
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
                print("Usage: herdr-listen [--state PATH] [--locale ko-KR] [--max-seconds 30] [--silence 1.2] [--laugh-threshold 0.1..0.99] [--no-laugh-filter] [--file AUDIO] [--debug-json] [--keep-audio 0..100]")
                exit(0)
            }
            if flag == "--debug-json" { debugJSON = true; continue }
            if flag == "--no-laugh-filter" { laughFilter = false; continue }
            guard ["--state", "--locale", "--max-seconds", "--silence", "--laugh-threshold", "--file", "--keep-audio"].contains(flag),
                  let value = args.next(), !value.isEmpty else {
                throw ListenError.message("Invalid argument: \(flag)")
            }
            switch flag {
            case "--state": statePath = value; explicitState = true
            case "--locale": locale = value
            case "--file": file = value
            case "--keep-audio":
                guard let count = Int(value), (0...100).contains(count) else {
                    throw ListenError.message("--keep-audio must be an integer between 0 and 100")
                }
                keepAudio = count
            case "--laugh-threshold":
                guard let score = Double(value), score.isFinite, (0.1...0.99).contains(score) else {
                    throw ListenError.message("--laugh-threshold must be between 0.1 and 0.99")
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
    var windows: [[String: Double]] = []
    var recordWindows = false
    var update: (([LaughRange], Bool, Double) -> Void)?
    var ended: (() -> Void)?
    var failed: (() -> Void)?

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
        if recordWindows { windows.append(["start": start, "end": end, "score": score]) }
        tracker.observe(windowStart: start, windowEnd: end, score: score)
        let ranges = tracker.ranges, laughing = tracker.isLaughing
        lock.unlock()
        update?(ranges, laughing, end)
    }
    func request(_ request: SNRequest, didFailWithError error: Error) { failed?() }
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
    var formattedTranscript = ""
    var finalizationDeadline: Double?
    var partialActivity: Double?
    var latestAudioEnd = 0.0
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
    // Only opt-in sessions retain PCM. The tap owns insertion and stopAudio()
    // removes the tap before finalization consumes these copies.
    let sampleLock = NSLock()
    var sampleBuffers: [AVAudioPCMBuffer] = []
    let created = Date()

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
            if analyzer != nil || self.options.keepAudio > 0, let copy = Self.copyBuffer(buffer) {
                if self.options.keepAudio > 0 {
                    self.sampleLock.lock()
                    self.sampleBuffers.append(copy)
                    self.sampleLock.unlock()
                }
                if let analyzer {
                    self.analysisQueue.async { analyzer.analyze(copy, atAudioFramePosition: position) }
                }
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
                self.latestAudioEnd = start + duration
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
                memcpy(dstData, srcData, Int(min(src.mDataByteSize, dst.mDataByteSize)))
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
            observer.recordWindows = options.debugJSON || options.keepAudio > 0
            observer.update = { ranges, laughing, end in
                DispatchQueue.main.async {
                    guard !self.completed, self.observer != nil else { return }
                    self.laughRanges = ranges
                    self.state.laughing = laughing
                    self.analyzedThrough = max(self.analyzedThrough, end)
                    self.refreshSpeechActivity()
                    self.refreshTranscript()
                    self.write()
                }
            }
            observer.failed = {
                DispatchQueue.main.async {
                    guard !self.completed, self.observer != nil else { return }
                    // Switch activity timestamps from the audio timeline to uptime.
                    let now = ProcessInfo.processInfo.systemUptime
                    self.lastActivity = self.heardSpeech ? now - max(0, self.latestAudioEnd - self.lastActivity) : now
                    self.observer = nil
                    self.state.laughing = false
                    self.laughRanges = []
                    self.refreshTranscript()
                    self.analysisDidFinish()
                    self.write()
                }
            }
            observer.ended = { DispatchQueue.main.async { self.analysisDidFinish() } }
            return (request, observer)
        } catch { return nil }
    }

    func refreshSpeechActivity(partialChanged: Bool = false) {
        guard options.file == nil else { return }
        if partialChanged && !state.laughing && !state.partial.isEmpty {
            if observer == nil {
                heardSpeech = true
                lastActivity = ProcessInfo.processInfo.systemUptime
                return
            }
            // Keep transcript activity on the same timeline as classified samples.
            partialActivity = latestAudioEnd
        }
        guard observer != nil else { return }
        let speech = loudSamples.filter {
            $0.start + $0.duration <= analyzedThrough &&
            keepSegment(start: $0.start, duration: $0.duration, ranges: laughRanges)
        }
        heardSpeech = !speech.isEmpty || partialActivity != nil
        lastActivity = max(speech.last.map { $0.start + $0.duration } ?? 0, partialActivity ?? 0)
    }

    func refreshTranscript() {
        let trimmed = trimTranscript(segments: segments, ranges: laughRanges)
        state.partial = trimmed.trimmed == 0 ? formattedTranscript : trimmed.text
        state.trimmed = trimmed.trimmed
    }

    func startRecognition(_ recognizer: SFSpeechRecognizer, _ request: SFSpeechRecognitionRequest) {
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                guard !self.completed, !self.recognitionFinished else { return }
                if let result {
                    let oldText = self.state.partial
                    self.formattedTranscript = result.bestTranscription.formattedString
                    self.segments = result.bestTranscription.segments.map { ($0.substring, $0.timestamp, $0.duration) }
                    self.refreshTranscript()
                    self.refreshSpeechActivity(partialChanged: oldText != self.state.partial)
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
        beginFinalizationDeadline()
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
        beginFinalizationDeadline()
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

    func beginFinalizationDeadline() {
        guard finalizationDeadline == nil else { return }
        finalizationDeadline = ProcessInfo.processInfo.systemUptime + 3
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.finalizeIfReady() }
    }

    func finalizeIfReady() {
        let expired = finalizationDeadline.map { ProcessInfo.processInfo.systemUptime >= $0 } ?? false
        guard !completed, (recognitionFinished && analysisFinished) || expired else { return }
        completed = true
        task?.cancel()
        refreshTranscript()
        state.final = state.partial
        state.state = state.final.isEmpty ? "idle" : "final"
        state.level = 0
        write(immediate: true)
        saveSample()
        printOfflineState()
        exit(0)
    }

    func sampleMetadata() -> [String: Any] {
        var windows: [[String: Double]] = []
        if let observer {
            observer.lock.lock()
            windows = observer.windows
            observer.lock.unlock()
        }
        return ["created": ISO8601DateFormatter().string(from: created),
                "locale": options.locale, "threshold": options.laughThreshold,
                "final": state.final, "formatted": formattedTranscript, "trimmed": state.trimmed,
                "classifier_available": observer != nil,
                "laugh_ranges": laughRanges.map { ["start": $0.start, "end": $0.end] },
                "windows": windows,
                "segments": segments.map { ["text": $0.text, "start": $0.start, "duration": $0.duration,
                    "kept": keepSegment(start: $0.start, duration: $0.duration, ranges: laughRanges)] as [String: Any] }]
    }

    func printOfflineState() {
        guard options.file != nil else { return }
        do {
            let encoded = try JSONEncoder().encode(state)
            var fields = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
            if options.debugJSON { fields.merge(sampleMetadata()) { _, new in new } }
            let data = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
            print(String(decoding: data, as: UTF8.self))
        } catch { fputs("herdr-listen: debug JSON failed: \(error)\n", stderr) }
    }

    func saveSample() {
        guard options.keepAudio > 0 else { return }
        let env = ProcessInfo.processInfo.environment
        let cache = env["XDG_CACHE_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (NSHomeDirectory() + "/.cache")
        let dir = URL(fileURLWithPath: cache).appendingPathComponent("herdr-hud/listen-samples", isDirectory: true)
        let fm = FileManager.default
        var wav: URL?, json: URL?, temporary: URL?
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
            // Serialize pair publication and pruning across concurrent offline runs.
            let lockFD = open(dir.appendingPathComponent(".lock").path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
            guard lockFD >= 0 else { throw ListenError.message("cannot lock sample directory") }
            defer { flock(lockFD, LOCK_UN); close(lockFD) }
            guard flock(lockFD, LOCK_EX) == 0 else { throw ListenError.message("cannot lock sample directory") }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"
            let stem = formatter.string(from: created) + "-" + UUID().uuidString
            let waveURL = dir.appendingPathComponent(stem + ".wav")
            let jsonURL = dir.appendingPathComponent(stem + ".json")
            let tempURL = dir.appendingPathComponent("." + stem + ".json.tmp")
            wav = waveURL; json = jsonURL; temporary = tempURL
            // Reserve with 0600 BEFORE AVAudioFile opens the path.
            let fd = open(waveURL.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            guard fd >= 0 else { throw ListenError.message("cannot create sample WAV") }
            close(fd)
            sampleLock.lock()
            let buffers = sampleBuffers
            sampleLock.unlock()
            try Self.writeSampleWAV(to: waveURL, buffers: buffers, source: options.file)
            let data = try JSONSerialization.data(withJSONObject: sampleMetadata(), options: [.sortedKeys])
            let jsonFD = open(tempURL.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            guard jsonFD >= 0 else { throw ListenError.message("cannot create sample JSON") }
            let handle = FileHandle(fileDescriptor: jsonFD, closeOnDealloc: true)
            try handle.write(contentsOf: data)
            try handle.close()
            guard rename(tempURL.path, jsonURL.path) == 0 else { throw ListenError.message("cannot publish sample JSON") }
            // The UTC prefix sorts chronologically; suffixes prevent same-second collisions.
            let pairs = try fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" && fm.fileExists(atPath: $0.deletingPathExtension().appendingPathExtension("wav").path) }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for old in pairs.prefix(max(0, pairs.count - options.keepAudio)) {
                try fm.removeItem(at: old.deletingPathExtension().appendingPathExtension("wav"))
                try fm.removeItem(at: old)
            }
        } catch {
            // Retention is diagnostic: never turn a successful command into an error.
            if let temporary { try? fm.removeItem(at: temporary) }
            // Preserve a published pair if only pruning failed.
            if let json, !fm.fileExists(atPath: json.path), let wav { try? fm.removeItem(at: wav) }
            fputs("herdr-listen: sample retention failed: \(error)\n", stderr)
        }
    }

    static func writeSampleWAV(to url: URL, buffers: [AVAudioPCMBuffer], source: String?) throws {
        let inputFile = try source.map { try AVAudioFile(forReading: URL(fileURLWithPath: $0)) }
        guard let format = inputFile?.processingFormat ?? buffers.first?.format,
              let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: outputFormat),
              let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 4096) else {
            throw ListenError.message("no captured audio or unsupported sample format")
        }
        let file = try AVAudioFile(forWriting: url, settings: outputFormat.settings,
                                   commonFormat: .pcmFormatInt16, interleaved: true)
        var index = 0
        var readError: Error?
        while true {
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                if let inputFile {
                    do {
                        if inputFile.framePosition >= inputFile.length {
                            inputStatus.pointee = .endOfStream
                            return nil
                        }
                        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096) else {
                            throw ListenError.message("cannot allocate sample buffer")
                        }
                        try inputFile.read(into: buffer)
                        if buffer.frameLength > 0 { inputStatus.pointee = .haveData; return buffer }
                    } catch { readError = error }
                } else if index < buffers.count {
                    let buffer = buffers[index]; index += 1
                    inputStatus.pointee = .haveData
                    return buffer
                }
                inputStatus.pointee = .endOfStream
                return nil
            }
            if let readError { throw ListenError.message("sample input read: \(readError)") }
            if status == .error { throw ListenError.message("sample converter: \(String(describing: error))") }
            if output.frameLength > 0 {
                do { try file.write(from: output) }
                catch { throw ListenError.message("sample output write: \(error)") }
            }
            if status == .endOfStream { break }
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
