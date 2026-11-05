import Foundation

struct LaughRange {
    var start: Double
    var end: Double
}

final class LaughTracker {
    let threshold: Double
    let strong: Double
    let padding: Double
    private var previous: (start: Double, end: Double, score: Double)?
    private(set) var ranges: [LaughRange] = []
    private(set) var isLaughing = false

    init(threshold: Double = 0.5, padding: Double = 0.15) {
        self.threshold = threshold
        self.strong = min(0.99, max(0.8, threshold + 0.15))
        self.padding = max(0, padding)
    }

    func observe(windowStart: Double, windowEnd: Double, score: Double) {
        guard windowStart.isFinite, windowEnd.isFinite, windowEnd >= windowStart, score.isFinite else { return }
        let consecutive = score >= threshold && (previous?.score ?? -Double.infinity) >= threshold
        isLaughing = score >= strong || consecutive
        if consecutive, let previous { add(start: previous.start, end: previous.end) }
        if isLaughing { add(start: windowStart, end: windowEnd) }
        previous = (windowStart, windowEnd, score)
    }

    private func add(start: Double, end: Double) {
        let candidate = LaughRange(start: max(0, start - padding), end: end + padding)
        ranges = mergedLaughRanges(ranges + [candidate], gap: padding)
    }
}

private func mergedLaughRanges(_ ranges: [LaughRange], gap: Double = 0) -> [LaughRange] {
    var merged: [LaughRange] = []
    for range in ranges.filter({ $0.end >= $0.start }).sorted(by: { $0.start < $1.start }) {
        if let last = merged.last, range.start <= last.end + gap {
            merged[merged.count - 1].end = max(last.end, range.end)
        } else { merged.append(range) }
    }
    return merged
}

func keepSegment(start: Double, duration: Double, ranges: [LaughRange]) -> Bool {
    if duration <= 0 { return !ranges.contains { start >= $0.start && start <= $0.end } }
    let overlap = mergedLaughRanges(ranges).reduce(0.0) {
        $0 + max(0, min(start + duration, $1.end) - max(start, $1.start))
    }
    return overlap <= duration * 0.5
}

func trimTranscript(segments: [(text: String, start: Double, duration: Double)],
                    ranges: [LaughRange]) -> (text: String, trimmed: Int) {
    let kept = segments.filter { keepSegment(start: $0.start, duration: $0.duration, ranges: ranges) }
    let text = kept.map(\.text).joined(separator: " ").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    return (text, segments.count - kept.count)
}
