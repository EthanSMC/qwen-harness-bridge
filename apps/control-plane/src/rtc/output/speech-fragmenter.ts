export const SPEAK_FRAGMENT_MAX_CHARACTERS = 120;
export const HIGHLIGHT_SUMMARY_MAX_CHARACTERS = 120;

const SENTENCE_PATTERN = /[^。！？；!?;\n]+[。！？；!?;]?/gu;
const TASK_ID_PATTERN = /QH-[A-Z0-9]{4,}/gu;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh", { granularity: "grapheme" })
    : undefined;

const graphemes = (value: string): string[] => {
  if (segmenter === undefined) return Array.from(value);
  return [...segmenter.segment(value)].map((segment) => segment.segment);
};

const clampCharacters = (value: string, max: number): string =>
  graphemes(value).slice(0, max).join("");

const taskIdRanges = (value: string): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(TASK_ID_PATTERN)) {
    const start = graphemes(value.slice(0, match.index)).length;
    ranges.push({ start, end: start + graphemes(match[0]).length });
  }
  return ranges;
};

/** Keep a short id whole when a hard cut would land inside it. */
const safeCut = (value: string, preferred: number): number => {
  for (const range of taskIdRanges(value)) {
    if (preferred > range.start && preferred < range.end) {
      return range.start > 0 ? range.start : range.end;
    }
  }
  return preferred;
};

/**
 * Splits speech at Chinese/English sentence punctuation first, then at Unicode
 * grapheme boundaries inside the documented fragment limit, keeping task short
 * ids intact.
 */
export const fragmentSpeech = (
  text: string,
  options: { maxCharacters?: number; highlight?: string } = {},
): Array<{ text: string; highlight?: string }> => {
  const max = Math.max(
    1,
    options.maxCharacters ?? SPEAK_FRAGMENT_MAX_CHARACTERS,
  );
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return [];
  const highlight =
    options.highlight === undefined
      ? undefined
      : clampCharacters(options.highlight, HIGHLIGHT_SUMMARY_MAX_CHARACTERS);

  const fragments: string[] = [];
  const sentences = normalized.match(SENTENCE_PATTERN) ?? [normalized];
  for (const sentence of sentences) {
    let rest = sentence;
    while (graphemes(rest).length > max) {
      const characters = graphemes(rest);
      const cut = safeCut(rest, max);
      fragments.push(characters.slice(0, cut).join(""));
      rest = characters.slice(cut).join("");
    }
    if (rest.length > 0) fragments.push(rest);
  }
  return fragments.map((fragment) => ({
    text: fragment,
    ...(highlight === undefined ? {} : { highlight }),
  }));
};
