import Foundation
import AVFoundation
import Speech
import Darwin

struct Options {
    var statePath: String
    var locale = "ko-KR"
    var maxSeconds = 30.0
    var silence = 1.2

    init() throws {
        let env = ProcessInfo.processInfo.environment
        let cache = env["XDG_CACHE_HOME"].flatMap { $0.isEmpty ? nil : $0 }
            ?? (NSHomeDirectory() + "/.cache")
        statePath = cache + "/herdr-hud/listen.json"
        var args = CommandLine.arguments.dropFirst().makeIterator()
        while let flag = args.next() {
            if flag == "--help" || flag == "-h" {
                print("Usage: herdr-listen [--state PATH] [--locale ko-KR] [--max-seconds 30] [--silence 1.2]")
                exit(0)
            }
            guard ["--state", "--locale", "--max-seconds", "--silence"].contains(flag),
                  let value = args.next(), !value.isEmpty else {
                throw ListenError.message("Invalid argument: \(flag)")
            }
            switch flag {
            case "--state": statePath = value
            case "--locale": locale = value
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
    let pid = getpid()
}

// All state and recognition lifecycle changes run on the main queue. The audio
// callback only measures its own buffer and queues a scalar level update.
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
        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    func write(immediate: Bool = false) {
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
                (self.heardSpeech && now - self.lastActivity >= self.options.silence) {
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
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        self.request = request
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("마이크 입력을 사용할 수 없습니다")
            return
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
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
            DispatchQueue.main.async {
                guard !self.finishing, !self.completed else { return }
                self.state.level = level
                if level > self.speechThreshold {
                    self.heardSpeech = true
                    self.lastActivity = ProcessInfo.processInfo.systemUptime
                }
                self.write()
            }
        }
        tapped = true
        task = recognizer.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async {
                guard !self.completed else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if text != self.state.partial {
                        self.state.partial = text
                        if !text.isEmpty {
                            self.heardSpeech = true
                            self.lastActivity = ProcessInfo.processInfo.systemUptime
                        }
                        self.write()
                    }
                    if result.isFinal { self.complete(); return }
                }
                if let error {
                    if self.finishing { self.complete() }
                    else { self.fail("음성 인식 오류: \(error.localizedDescription)") }
                }
            }
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            fail("마이크를 시작할 수 없습니다: \(error.localizedDescription)")
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
        completed = true
        stopAudio()
        task?.cancel()
        state.final = state.partial.trimmingCharacters(in: .whitespacesAndNewlines)
        state.state = state.final.isEmpty ? "idle" : "final"
        state.level = 0
        write(immediate: true)
        exit(0)
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
