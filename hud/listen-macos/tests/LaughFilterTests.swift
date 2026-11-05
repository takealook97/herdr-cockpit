import Foundation

@main
struct LaughFilterTests {
    static func main() {
        let tracker = LaughTracker()
        tracker.observe(windowStart: 0, windowEnd: 1, score: 0.6)
        assert(!tracker.isLaughing && tracker.ranges.isEmpty, "one weak window")
        tracker.observe(windowStart: 0.5, windowEnd: 1.5, score: 0.6)
        assert(tracker.isLaughing && tracker.ranges.count == 1, "two weak windows")
        assert(tracker.ranges[0].start == 0 && abs(tracker.ranges[0].end - 1.65) < 0.00001, "padding + merge")
        tracker.observe(windowStart: 1, windowEnd: 2, score: 0.1)
        assert(!tracker.isLaughing, "negative resets current state")
        let strong = LaughTracker()
        strong.observe(windowStart: 2, windowEnd: 3, score: 0.9)
        assert(strong.isLaughing && strong.ranges.count == 1, "one strong window")
        strong.observe(windowStart: 3.4, windowEnd: 4, score: 0.9)
        assert(strong.ranges.count == 1 && abs(strong.ranges[0].start - 1.85) < 0.00001, "padded adjacency")
        let strict = LaughTracker(threshold: 0.95)
        strict.observe(windowStart: 0, windowEnd: 1, score: 0.85)
        assert(!strict.isLaughing && strict.ranges.isEmpty, "high threshold raises strong cutoff")
        assert(strict.strong == 0.99, "strong cutoff capped at 0.99")
        let range = [LaughRange(start: 0, end: 0.6)]
        assert(!keepSegment(start: 0, duration: 1, ranges: range), "60 percent removed")
        assert(keepSegment(start: 0.3, duration: 1, ranges: range), "30 percent kept")
        assert(keepSegment(start: 0.1, duration: 1, ranges: range), "exactly half kept")
        assert(!keepSegment(start: 0.2, duration: 0, ranges: range), "zero duration inside")
        assert(keepSegment(start: 1, duration: 0, ranges: range), "zero duration outside")
        assert(keepSegment(start: 0, duration: 1, ranges: [LaughRange(start: 0, end: 0.3), LaughRange(start: 0.1, end: 0.4)]), "union not double counted")
        let result = trimTranscript(segments: [("ontology에", 0, 0.6), ("하하하", 0.7, 0.8), ("테스트", 1.6, 0.4), ("돌려", 2, 0.3)], ranges: [LaughRange(start: 0.65, end: 1.5)])
        assert(result.text == "ontology에 테스트 돌려" && result.trimmed == 1)
        assert(trimTranscript(segments: [("  안녕\n 세상 ", 0, 1)], ranges: []).text == "안녕 세상")
        assert(trimTranscript(segments: [("하하", 0, 1)], ranges: [LaughRange(start: 0, end: 1)]).text.isEmpty)
        print("LaughFilter tests passed")
    }
}
