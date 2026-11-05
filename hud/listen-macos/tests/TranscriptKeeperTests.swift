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

        var transcript = AnalyzerTranscript()
        transcript.observe(text: "A partial", segments: [("A partial", 0, 2)], isFinal: false)
        transcript.observe(text: "A full", segments: [("A full", 0, 3)], isFinal: false)
        assert(transcript.text == "A full", "volatile updates replace the entire hypothesis")
        assert(transcript.segments.count == 1 && transcript.segments[0].duration == 3,
               "volatile timing is replaced with the latest result")
        transcript.observe(text: "A", segments: [("A", 1.9, 1)], isFinal: true)
        assert(transcript.text == "A", "final replaces volatile even with little timing overlap")
        assert(transcript.finalized == "A" && transcript.volatile.isEmpty && transcript.volatileSegments.isEmpty,
               "final appends to finalized text and clears volatile text and timing")
        assert(transcript.segments.count == 1 && transcript.segments[0].start == 1.9)

        var sequence = AnalyzerTranscript()
        sequence.observe(text: "A", segments: [("A", 0, 2)], isFinal: false)
        sequence.observe(text: "A", segments: [("A", 1.9, 1)], isFinal: true)
        sequence.observe(text: "B", segments: [("B", 2, 2)], isFinal: false)
        assert(sequence.text == "A B" && sequence.segments.map { $0.text } == ["A", "B"],
               "display and laughter trimming combine finalized and latest volatile results")
        sequence.observe(text: "B", segments: [("B", 3.9, 1)], isFinal: true)
        assert(sequence.text == "A B", "volatile/final pairs must not duplicate sentences")
        assert(sequence.finalized == "A B" && sequence.volatile.isEmpty)
        assert(sequence.segments.map { $0.start } == [1.9, 3.9], "only finalized timing survives")
        let laughterTrimmed = trimTranscript(segments: sequence.segments, ranges: [LaughRange(start: 3.9, end: 4.9)])
        assert(laughterTrimmed.text == "A" && laughterTrimmed.trimmed == 1)

        for isFinal in [false, true] {
            sequence.observe(text: "", segments: [], isFinal: isFinal)
            sequence.observe(text: " \n ", segments: [], isFinal: isFinal)
            assert(sequence.text == "A B" && sequence.segments.count == 2,
                   "empty results never erase finalized text or timing")
        }
        sequence.observe(text: "C", segments: [("C", 5, 1)], isFinal: false)
        for isFinal in [false, true] {
            sequence.observe(text: " \n ", segments: [], isFinal: isFinal)
            assert(sequence.text == "A B C" && sequence.volatile == "C" && sequence.segments.count == 3,
                   "empty results never erase the last useful volatile text or timing")
        }
        print("TranscriptKeeper tests passed")
    }
}
