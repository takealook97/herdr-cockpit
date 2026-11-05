import Foundation

// Recognition engines can emit an empty final after useful volatile results.
struct TranscriptKeeper {
    private(set) var text = ""
    private(set) var segments: [(text: String, start: Double, duration: Double)] = []

    mutating func observe(text: String, segments: [(text: String, start: Double, duration: Double)]) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        self.text = text
        self.segments = segments
    }
}

// SpeechTranscriber final results append; each volatile result replaces the
// pending hypothesis wholesale. Empty results retain the last useful text.
struct AnalyzerTranscript {
    typealias Segment = (text: String, start: Double, duration: Double)
    private(set) var finalized = ""
    private(set) var volatile = ""
    private(set) var finalizedSegments: [Segment] = []
    private(set) var volatileSegments: [Segment] = []

    var text: String {
        [finalized, volatile].filter { !$0.isEmpty }.joined(separator: " ")
    }

    var segments: [Segment] { finalizedSegments + volatileSegments }

    mutating func observe(text: String, segments: [Segment], isFinal: Bool) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if isFinal {
            finalized = [finalized, text].filter { !$0.isEmpty }.joined(separator: " ")
            finalizedSegments.append(contentsOf: segments)
            volatile = ""
            volatileSegments = []
        } else {
            volatile = text
            volatileSegments = segments
        }
    }
}

func contextualHints(_ value: String) -> [String] {
    let originals = value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter {
        !$0.isEmpty && $0.count <= 64 && !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }
    let spaced = originals.map { $0.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ") }
    let joined = spaced.map { $0.components(separatedBy: .whitespaces).joined() }
    var seen = Set<String>()
    var result: [String] = []
    let ignored = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)
    for variant in originals + spaced + joined {
        guard variant.unicodeScalars.contains(where: { !ignored.contains($0) }),
              seen.insert(variant).inserted else { continue }
        result.append(variant)
        if result.count == 100 { break }
    }
    return result
}
