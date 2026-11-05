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
        assert(contextualHints("wiki-island,ontology,space_l,wiki-island") == ["wiki-island", "ontology", "space_l", "wiki island", "space l", "wikiisland", "spacel"])
        assert(contextualHints(String(repeating: "가", count: 65) + ",bad\u{0}hint,온톨로지") == ["온톨로지"])
        assert(contextualHints("-,_,...,  ,wiki-island,space_l") == ["wiki-island", "space_l", "wiki island", "space l", "wikiisland", "spacel"])
        assert(contextualHints("-,_,🎙️") == ["🎙️"], "symbol names are not punctuation-only")
        let originals = (0..<200).map { "head-\($0)" }
        assert(contextualHints(originals.joined(separator: ",")) == Array(originals.prefix(100)))
        assert(contextualHints("a-b,a b,ab,a_b") == ["a-b", "a b", "ab", "a_b"])

        let earlier = TranscriptPiece(start: 0, end: 2, text: "final", segments: [("final", 0, 2)])
        let later = TranscriptPiece(start: 2, end: 3, text: "tail", segments: [("tail", 2, 1)])
        let correction = TranscriptPiece(start: 0, end: 2.1, text: "corrected", segments: [("corrected", 0, 2.1)])
        let merged = mergingTranscriptPieces([earlier, later], with: correction)
        assert(merged.map(\.text) == ["corrected", "tail"], "slight overlap must retain the later phrase")
        assert(merged.flatMap(\.segments).map { $0.text } == ["corrected", "tail"])
        assert(mergingTranscriptPieces([later], with: earlier).map(\.text) == ["final", "tail"], "touching pieces remain ordered")
        assert(mergingTranscriptPieces([later], with: TranscriptPiece(start: 0, end: 1, text: "before")).map(\.text) == ["before", "tail"], "non-overlapping later piece survives")
        assert(mergingTranscriptPieces([later], with: TranscriptPiece(start: 0, end: 2.5, text: "half")).count == 2, "exactly half overlap keeps the tail")
        assert(mergingTranscriptPieces([later], with: TranscriptPiece(start: 0, end: 2.51, text: "most")).map(\.text) == ["most"], "more than half overlap replaces the tail")
        assert(mergingTranscriptPieces([earlier], with: TranscriptPiece(start: 0, end: 2, text: "new")).map(\.text) == ["new"])
        assert(mergingTranscriptPieces([earlier], with: TranscriptPiece(start: 1, end: 3, text: "next")).map(\.text) == ["next"], "overlapping earlier piece is replaced")
        print("TranscriptKeeper tests passed")
    }
}
