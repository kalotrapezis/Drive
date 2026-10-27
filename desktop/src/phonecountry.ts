import { AsYouType } from 'libphonenumber-js'

/**
 * A number or the start of one (a spam range's 69800) as + its country code and the rest, a national one read in the phone's
 * country (Drive-Android PhoneCountry.international; main.js spamInternational): 6980012345 in Greece is +306980012345,
 * Germany's 0171… is +49171…, Italy's 06… keeps its 0 (+3906…). Without a country a national number stays its digits.
 */
export const international = (n: string, country: string) => {
  const a = new AsYouType((country || undefined) as never); a.input(n.trim())
  return a.getNumberValue() || n.replace(/\D/g, '')
}
