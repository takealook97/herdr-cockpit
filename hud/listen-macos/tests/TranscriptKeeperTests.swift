import Foundation

@main
struct TranscriptKeeperTests {
    static func main() {
        var keeper = TranscriptKeeper()
        keeper.observe(text: "위키 아일랜드 지금", segments: [("위키", 0, 0.5), ("아일랜드 지금", 0.5, 1)])
        keeper.observe(text: "", segments: [])
        keeper.observe(text: " \n ", segments: [])
        assert(keeper.text == "위키 아일랜드 지금" && keeper.segments.count == 2, "empty final must retain text and timing")
        keeper.observe(text: "위키 아일랜드 테스트", segments: [("위키 아일랜드 테스트", 0, 2)])
        assert(keeper.text == "위키 아일랜드 테스트" && keeper.segments.count == 1, "nonempty corrections replace prior hypothesis")
        keeper.observe(text: "하하", segments: [("하하", 0, 1)])
        let trimmed = trimTranscript(segments: keeper.segments, ranges: [LaughRange(start: 0, end: 1)])
        assert(trimmed.text.isEmpty && trimmed.trimmed == 1, "retention must not bypass laughter trimming")
        assert(contextualHints("wiki-island,ontology,space_l,wiki-island") == ["wiki-island", "wiki island", "wikiisland", "ontology", "space_l", "space l", "spacel"])
        assert(contextualHints(String(repeating: "가", count: 65) + ",bad\u{0}hint,온톨로지") == ["온톨로지"])
        assert(contextualHints((0..<200).map { "head-\($0)" }.joined(separator: ",")).count == 100)
        print("TranscriptKeeper tests passed")
    }
}
