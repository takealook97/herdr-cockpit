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

// Replace a stored hypothesis only when more than half its duration overlaps.
// Zero-duration pieces are replaced when their point is inside the new range.
struct TranscriptPiece {
    var start: Double
    var end: Double
    var text: String
    var segments: [(text: String, start: Double, duration: Double)] = []
}

func mergingTranscriptPieces(_ pieces: [TranscriptPiece], with new: TranscriptPiece) -> [TranscriptPiece] {
    let retained = pieces.filter { piece in
        let duration = piece.end - piece.start
        if duration == 0 { return !(new.start <= piece.start && piece.start <= new.end) }
        let overlap = max(0, min(piece.end, new.end) - max(piece.start, new.start))
        return overlap <= duration * 0.5
    }
    return (retained + [new]).sorted { $0.start < $1.start }
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
