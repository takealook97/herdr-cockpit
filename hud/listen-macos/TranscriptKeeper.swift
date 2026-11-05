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

func contextualHints(_ value: String) -> [String] {
    var seen = Set<String>()
    var result: [String] = []
    for entry in value.split(separator: ",") {
        let hint = entry.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !hint.isEmpty, hint.count <= 64,
              !hint.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { continue }
        let spaced = hint.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        let joined = spaced.components(separatedBy: .whitespaces).joined()
        for variant in [hint, spaced, joined] where !variant.isEmpty && seen.insert(variant).inserted {
            result.append(variant)
            if result.count == 100 { return result }
        }
    }
    return result
}
