import createVisual from '../../../src/content_scripts/common/visual.js';

/*
 * The LLM chat's highlight_on_page marks a passage through Visual.highlightMatches.
 * jsdom lays nothing out, so the text and its ranges are given a box to be found in.
 */
describe('Visual.highlightMatches', () => {
    const box = {top: 10, left: 10, bottom: 30, right: 110, width: 100, height: 20};
    let originalRangeRects;

    beforeEach(() => {
        document.body.innerHTML = '<p>alpha beta alpha</p>';
        jest.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
        jest.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(box);
        Object.defineProperty(document, 'scrollingElement', {
            configurable: true,
            get: () => document.documentElement,
        });
        originalRangeRects = Range.prototype.getClientRects;
        Range.prototype.getClientRects = () => [box];
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete document.scrollingElement;
        Range.prototype.getClientRects = originalRangeRects;
    });

    it('marks every occurrence and brings the first into view', () => {
        const visual = createVisual({}, {});
        expect(visual.highlightMatches('alpha')).toBe(2);
    });
});
