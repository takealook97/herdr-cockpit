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

// Replace overlapping hypotheses, preserving a later phrase when only its
// leading edge overlaps (at most half its duration). Touching ranges stay intact.
struct TranscriptPiece {
    var start: Double
    var end: Double
    var text: String
    var segments: [(text: String, start: Double, duration: Double)] = []
}

func mergingTranscriptPieces(_ pieces: [TranscriptPiece], with new: TranscriptPiece) -> [TranscriptPiece] {
    let retained = pieces.filter { piece in
        guard piece.start < new.end && piece.end > new.start else { return true }
        let overlap = min(piece.end, new.end) - max(piece.start, new.start)
        return piece.start > new.start && overlap <= (piece.end - piece.start) * 0.5
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
