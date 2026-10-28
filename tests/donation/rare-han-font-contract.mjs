export const RARE_HAN_CODEPOINTS = Object.freeze([0x5754, 0x6db3]);
export const RARE_HAN_FAMILY = 'Huiwen Sans Rare Han Support';

// A supplemental face is not a blanket exception for ordinary Han characters.
export function allowsRareHanFont(fonts, text) {
  const han = [...String(text || '')].filter(character => /\p{Script=Han}/u.test(character));
  return han.length > 0 && han.every(character => RARE_HAN_CODEPOINTS.includes(character.codePointAt(0)))
    && fonts.some(font => font.isCustomFont && String(font.familyName).replace(/ \(Fontations\)$/, '') === RARE_HAN_FAMILY);
}
