/* js/244-gift-postal.js — Gift a Book: on-device postal validation data + checks.
 *
 * Everything in this file is vendored reference data and pure functions.
 * NOTHING here makes a network call of any kind — the address this
 * validates is the app's most sensitive datum, and validation must leak
 * nothing. (A source pin in .test/gift-a-book.test.js enforces this.)
 *
 * Country list: ISO 3166-1 alpha-2 (249 entries incl. XK user-assigned).
 * Postal formats: per-country patterns after the Universal Postal Union's
 * published per-country formats and Google's libaddressinput metadata,
 * retrieved 2026-10-16. Patterns are deliberately conservative: strict
 * where the format is rigid and well documented, permissive where real
 * codes vary — a wrong strict pattern must never hard-block a real code.
 * Countries absent from GIFT_POSTAL_FORMATS and GIFT_NO_POSTAL are
 * simply not validated (verdict 'skip').
 *
 * Canadian FSA set: Canada Post's official FSA listing (March 2026
 * edition) cross-checked against the per-letter FSA lists published by
 * Wikipedia (which cite Canada Post and Statistics Canada) and a
 * licensed Canada Post distributor's provincial grids, retrieved
 * 2026-10-16. 1,676 FSAs. The set drifts as Canada Post adds areas, so
 * a miss is a SOFT warning by design — never a block.
 */

const GIFT_COUNTRIES = [
  ['CA', 'Canada'], ['US', 'United States'], ['GB', 'United Kingdom'], ['AF', 'Afghanistan'],
  ['AL', 'Albania'], ['DZ', 'Algeria'], ['AS', 'American Samoa'], ['AD', 'Andorra'],
  ['AO', 'Angola'], ['AI', 'Anguilla'], ['AQ', 'Antarctica'], ['AG', 'Antigua and Barbuda'],
  ['AR', 'Argentina'], ['AM', 'Armenia'], ['AW', 'Aruba'], ['AU', 'Australia'],
  ['AT', 'Austria'], ['AZ', 'Azerbaijan'], ['BS', 'Bahamas'], ['BH', 'Bahrain'],
  ['BD', 'Bangladesh'], ['BB', 'Barbados'], ['BY', 'Belarus'], ['BE', 'Belgium'],
  ['BZ', 'Belize'], ['BJ', 'Benin'], ['BM', 'Bermuda'], ['BT', 'Bhutan'],
  ['BO', 'Bolivia'], ['BQ', 'Bonaire, Sint Eustatius and Saba'], ['BA', 'Bosnia and Herzegovina'], ['BW', 'Botswana'],
  ['BV', 'Bouvet Island'], ['BR', 'Brazil'], ['IO', 'British Indian Ocean Territory'], ['BN', 'Brunei'],
  ['BG', 'Bulgaria'], ['BF', 'Burkina Faso'], ['BI', 'Burundi'], ['KH', 'Cambodia'],
  ['CM', 'Cameroon'], ['CV', 'Cabo Verde'], ['KY', 'Cayman Islands'], ['CF', 'Central African Republic'],
  ['TD', 'Chad'], ['CL', 'Chile'], ['CN', 'China'], ['CX', 'Christmas Island'],
  ['CC', 'Cocos (Keeling) Islands'], ['CO', 'Colombia'], ['KM', 'Comoros'], ['CG', 'Congo'],
  ['CD', 'Congo, Democratic Republic of the'], ['CK', 'Cook Islands'], ['CR', 'Costa Rica'], ['CI', 'Côte d\'Ivoire'],
  ['HR', 'Croatia'], ['CU', 'Cuba'], ['CW', 'Curaçao'], ['CY', 'Cyprus'],
  ['CZ', 'Czechia'], ['DK', 'Denmark'], ['DJ', 'Djibouti'], ['DM', 'Dominica'],
  ['DO', 'Dominican Republic'], ['EC', 'Ecuador'], ['EG', 'Egypt'], ['SV', 'El Salvador'],
  ['GQ', 'Equatorial Guinea'], ['ER', 'Eritrea'], ['EE', 'Estonia'], ['SZ', 'Eswatini'],
  ['ET', 'Ethiopia'], ['FK', 'Falkland Islands'], ['FO', 'Faroe Islands'], ['FJ', 'Fiji'],
  ['FI', 'Finland'], ['FR', 'France'], ['GF', 'French Guiana'], ['PF', 'French Polynesia'],
  ['TF', 'French Southern Territories'], ['GA', 'Gabon'], ['GM', 'Gambia'], ['GE', 'Georgia'],
  ['DE', 'Germany'], ['GH', 'Ghana'], ['GI', 'Gibraltar'], ['GR', 'Greece'],
  ['GL', 'Greenland'], ['GD', 'Grenada'], ['GP', 'Guadeloupe'], ['GU', 'Guam'],
  ['GT', 'Guatemala'], ['GG', 'Guernsey'], ['GN', 'Guinea'], ['GW', 'Guinea-Bissau'],
  ['GY', 'Guyana'], ['HT', 'Haiti'], ['HM', 'Heard Island and McDonald Islands'], ['VA', 'Holy See'],
  ['HN', 'Honduras'], ['HK', 'Hong Kong'], ['HU', 'Hungary'], ['IS', 'Iceland'],
  ['IN', 'India'], ['ID', 'Indonesia'], ['IR', 'Iran'], ['IQ', 'Iraq'],
  ['IE', 'Ireland'], ['IM', 'Isle of Man'], ['IL', 'Israel'], ['IT', 'Italy'],
  ['JM', 'Jamaica'], ['JP', 'Japan'], ['JE', 'Jersey'], ['JO', 'Jordan'],
  ['KZ', 'Kazakhstan'], ['KE', 'Kenya'], ['KI', 'Kiribati'], ['KP', 'Korea, North'],
  ['KR', 'Korea, South'], ['XK', 'Kosovo'], ['KW', 'Kuwait'], ['KG', 'Kyrgyzstan'],
  ['LA', 'Laos'], ['LV', 'Latvia'], ['LB', 'Lebanon'], ['LS', 'Lesotho'],
  ['LR', 'Liberia'], ['LY', 'Libya'], ['LI', 'Liechtenstein'], ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'], ['MO', 'Macao'], ['MG', 'Madagascar'], ['MW', 'Malawi'],
  ['MY', 'Malaysia'], ['MV', 'Maldives'], ['ML', 'Mali'], ['MT', 'Malta'],
  ['MH', 'Marshall Islands'], ['MQ', 'Martinique'], ['MR', 'Mauritania'], ['MU', 'Mauritius'],
  ['YT', 'Mayotte'], ['MX', 'Mexico'], ['FM', 'Micronesia'], ['MD', 'Moldova'],
  ['MC', 'Monaco'], ['MN', 'Mongolia'], ['ME', 'Montenegro'], ['MS', 'Montserrat'],
  ['MA', 'Morocco'], ['MZ', 'Mozambique'], ['MM', 'Myanmar'], ['NA', 'Namibia'],
  ['NR', 'Nauru'], ['NP', 'Nepal'], ['NL', 'Netherlands'], ['NC', 'New Caledonia'],
  ['NZ', 'New Zealand'], ['NI', 'Nicaragua'], ['NE', 'Niger'], ['NG', 'Nigeria'],
  ['NU', 'Niue'], ['NF', 'Norfolk Island'], ['MK', 'North Macedonia'], ['MP', 'Northern Mariana Islands'],
  ['NO', 'Norway'], ['OM', 'Oman'], ['PK', 'Pakistan'], ['PW', 'Palau'],
  ['PS', 'Palestine'], ['PA', 'Panama'], ['PG', 'Papua New Guinea'], ['PY', 'Paraguay'],
  ['PE', 'Peru'], ['PH', 'Philippines'], ['PN', 'Pitcairn'], ['PL', 'Poland'],
  ['PT', 'Portugal'], ['PR', 'Puerto Rico'], ['QA', 'Qatar'], ['RE', 'Réunion'],
  ['RO', 'Romania'], ['RU', 'Russia'], ['RW', 'Rwanda'], ['BL', 'Saint Barthélemy'],
  ['SH', 'Saint Helena'], ['KN', 'Saint Kitts and Nevis'], ['LC', 'Saint Lucia'], ['MF', 'Saint Martin'],
  ['PM', 'Saint Pierre and Miquelon'], ['VC', 'Saint Vincent and the Grenadines'], ['WS', 'Samoa'], ['SM', 'San Marino'],
  ['ST', 'Sao Tome and Principe'], ['SA', 'Saudi Arabia'], ['SN', 'Senegal'], ['RS', 'Serbia'],
  ['SC', 'Seychelles'], ['SL', 'Sierra Leone'], ['SG', 'Singapore'], ['SX', 'Sint Maarten'],
  ['SK', 'Slovakia'], ['SI', 'Slovenia'], ['SB', 'Solomon Islands'], ['SO', 'Somalia'],
  ['ZA', 'South Africa'], ['GS', 'South Georgia'], ['SS', 'South Sudan'], ['ES', 'Spain'],
  ['LK', 'Sri Lanka'], ['SD', 'Sudan'], ['SR', 'Suriname'], ['SJ', 'Svalbard and Jan Mayen'],
  ['SE', 'Sweden'], ['CH', 'Switzerland'], ['SY', 'Syria'], ['TW', 'Taiwan'],
  ['TJ', 'Tajikistan'], ['TZ', 'Tanzania'], ['TH', 'Thailand'], ['TL', 'Timor-Leste'],
  ['TG', 'Togo'], ['TK', 'Tokelau'], ['TO', 'Tonga'], ['TT', 'Trinidad and Tobago'],
  ['TN', 'Tunisia'], ['TR', 'Türkiye'], ['TM', 'Turkmenistan'], ['TC', 'Turks and Caicos Islands'],
  ['TV', 'Tuvalu'], ['UG', 'Uganda'], ['UA', 'Ukraine'], ['AE', 'United Arab Emirates'],
  ['UM', 'United States Minor Outlying Islands'], ['UY', 'Uruguay'], ['UZ', 'Uzbekistan'], ['VU', 'Vanuatu'],
  ['VE', 'Venezuela'], ['VN', 'Vietnam'], ['VG', 'Virgin Islands, British'], ['VI', 'Virgin Islands, U.S.'],
  ['WF', 'Wallis and Futuna'], ['EH', 'Western Sahara'], ['YE', 'Yemen'], ['ZM', 'Zambia'],
  ['ZW', 'Zimbabwe'], ['AX', 'Åland Islands'],
];

/* code -> regex source (the validator anchors it). CA and US are
 * special-cased in giftPostalCheck and intentionally absent here. */
const GIFT_POSTAL_FORMATS = {
  'AD': 'AD\\d{3}', 'AF': '\\d{4}', 'AL': '\\d{4}', 'AM': '\\d{4}',
  'AR': '([A-Z]\\d{4}[A-Z]{3}|\\d{4})', 'AS': '96799(-\\d{4})?', 'AT': '\\d{4}', 'AU': '\\d{4}',
  'AX': '22\\d{3}', 'AZ': '\\d{4}', 'BA': '\\d{5}', 'BB': '[A-Z]{2}\\d{5}',
  'BD': '\\d{4}', 'BE': '\\d{4}', 'BG': '\\d{4}', 'BH': '\\d{3,4}',
  'BL': '\\d{5}', 'BM': '[A-Z]{2} ?\\d{2}', 'BN': '[A-Z]{2}\\d{4}', 'BO': '\\d{4}',
  'BR': '\\d{5}-?\\d{3}', 'BT': '\\d{5}', 'BY': '\\d{6}', 'CC': '\\d{4}',
  'CH': '\\d{4}', 'CL': '\\d{7}', 'CN': '\\d{6}', 'CO': '\\d{6}',
  'CR': '\\d{5}', 'CU': '\\d{5}', 'CV': '\\d{4}', 'CX': '\\d{4}',
  'CY': '\\d{4}', 'CZ': '\\d{3} ?\\d{2}', 'DE': '\\d{5}', 'DK': '\\d{4}',
  'DO': '\\d{5}', 'DZ': '\\d{5}', 'EC': '\\d{6}', 'EE': '\\d{5}',
  'EG': '\\d{5}', 'EH': '\\d{5}', 'ES': '\\d{5}', 'ET': '\\d{4}',
  'FI': '\\d{5}', 'FK': 'FIQQ ?1ZZ', 'FM': '9694\\d', 'FO': '\\d{3}',
  'FR': '\\d{5}', 'GB': '(GIR ?0AA|[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2})', 'GE': '\\d{4}', 'GF': '\\d{5}',
  'GG': 'GY\\d ?\\d[A-Z]{2}', 'GI': 'GX11 ?1AA', 'GL': '39\\d{2}', 'GP': '\\d{5}',
  'GR': '\\d{3} ?\\d{2}', 'GS': 'SIQQ ?1ZZ', 'GT': '\\d{5}', 'GU': '969[123]\\d(-\\d{4})?',
  'HM': '\\d{4}', 'HN': '\\d{5}', 'HR': '\\d{5}', 'HT': '(HT ?)?\\d{4}',
  'HU': '\\d{4}', 'ID': '\\d{5}', 'IE': '[A-Z0-9]{3} ?[A-Z0-9]{4}', 'IL': '(\\d{7}|\\d{5})',
  'IM': 'IM\\d ?\\d[A-Z]{2}', 'IN': '\\d{6}', 'IO': 'BBND ?1ZZ', 'IQ': '\\d{5}',
  'IR': '(\\d{10}|\\d{5}-\\d{5})', 'IS': '\\d{3}', 'IT': '\\d{5}', 'JE': 'JE\\d ?\\d[A-Z]{2}',
  'JO': '\\d{5}', 'JP': '\\d{3}-\\d{4}', 'KE': '\\d{5}', 'KG': '\\d{6}',
  'KH': '\\d{5}', 'KR': '\\d{5}', 'KW': '\\d{5}', 'KY': 'KY\\d-\\d{4}',
  'KZ': '\\d{6}', 'LA': '\\d{5}', 'LB': '(\\d{4}( ?\\d{4})?)', 'LI': '94\\d{2}',
  'LK': '\\d{5}', 'LS': '\\d{3}', 'LT': '\\d{5}', 'LU': '\\d{4}',
  'LV': '\\d{4}', 'MC': '980\\d{2}', 'MD': '\\d{4}', 'ME': '\\d{5}',
  'MF': '\\d{5}', 'MG': '\\d{3}', 'MH': '9696\\d(-\\d{4})?', 'MK': '\\d{4}',
  'MM': '\\d{5}', 'MN': '\\d{5}', 'MP': '9695\\d', 'MQ': '\\d{5}',
  'MS': '[A-Z]{3} ?\\d{4}', 'MT': '[A-Z]{3} ?\\d{4}', 'MV': '\\d{5}', 'MX': '\\d{5}',
  'MY': '\\d{5}', 'MZ': '\\d{4}', 'NC': '988\\d{2}', 'NF': '\\d{4}',
  'NG': '\\d{6}', 'NL': '\\d{4} ?[A-Z]{2}', 'NO': '\\d{4}', 'NP': '\\d{5}',
  'NZ': '\\d{4}', 'OM': '\\d{3}', 'PA': '\\d{4}', 'PE': '\\d{5}',
  'PF': '987\\d{2}', 'PG': '\\d{3}', 'PH': '\\d{4}', 'PK': '\\d{5}',
  'PL': '\\d{2}-\\d{3}', 'PM': '\\d{5}', 'PN': 'PCRN ?1ZZ', 'PR': '00\\d{3}(-\\d{4})?',
  'PT': '\\d{4}-\\d{3}', 'PW': '96940', 'PY': '\\d{4}', 'RE': '\\d{5}',
  'RO': '\\d{6}', 'RS': '\\d{5}', 'RU': '\\d{6}', 'SA': '\\d{5}(-\\d{4})?',
  'SE': '\\d{3} ?\\d{2}', 'SG': '\\d{6}', 'SH': '[A-Z]{4} ?1ZZ', 'SI': '\\d{4}',
  'SJ': '\\d{4}', 'SK': '\\d{3} ?\\d{2}', 'SM': '4789\\d', 'SV': '(CP ?)?\\d{4}',
  'SZ': '[A-Z]\\d{3}', 'TC': 'TKCA ?1ZZ', 'TH': '\\d{5}', 'TJ': '\\d{6}',
  'TM': '\\d{6}', 'TN': '\\d{4}', 'TR': '\\d{5}', 'TW': '\\d{3}(-\\d{2})?',
  'TZ': '\\d{5}', 'UA': '\\d{5}', 'UY': '\\d{5}', 'UZ': '\\d{6}',
  'VA': '00120', 'VE': '\\d{4}', 'VG': 'VG\\d{4}', 'VI': '008\\d{2}(-\\d{4})?',
  'VN': '\\d{6}', 'WF': '986\\d{2}', 'XK': '\\d{5}', 'YT': '\\d{5}',
  'ZA': '\\d{4}', 'ZM': '\\d{5}',
};

/* Countries/territories with NO postal code system: the postal field
 * is optional there and anything entered goes unvalidated. */
const GIFT_NO_POSTAL = {
  'AE': true, 'AG': true, 'AI': true, 'AQ': true, 'AW': true, 'BF': true, 'BI': true, 'BJ': true,
  'BQ': true, 'BS': true, 'BW': true, 'BZ': true, 'CF': true, 'CG': true, 'CK': true, 'CM': true,
  'CW': true, 'DJ': true, 'DM': true, 'ER': true, 'FJ': true, 'GA': true, 'GD': true, 'GH': true,
  'GM': true, 'GQ': true, 'GY': true, 'HK': true, 'JM': true, 'KI': true, 'KM': true, 'KN': true,
  'KP': true, 'LC': true, 'ML': true, 'MO': true, 'MR': true, 'NR': true, 'NU': true, 'QA': true,
  'RW': true, 'SB': true, 'SC': true, 'SL': true, 'SO': true, 'SR': true, 'SS': true, 'ST': true,
  'SX': true, 'TD': true, 'TG': true, 'TK': true, 'TL': true, 'TO': true, 'TV': true, 'UG': true,
  'VC': true, 'VU': true, 'WS': true, 'ZW': true,
};

/* Canadian forward sortation areas, grouped by first letter (packed
 * space-joined lists; membership is an exact-token test). */
const GIFT_FSA_BY_LETTER = {
  'A': 'A0A A0B A0C A0E A0G A0H A0J A0K A0L A0M A0N A0P ' +
    'A0R A0Z A1A A1B A1C A1E A1G A1H A1K A1L A1M A1N ' +
    'A1S A1V A1W A1X A1Y A2A A2B A2H A2N A2V A5A A8A',
  'B': 'B0C B0E B0H B0J B0K B0L B0M B0N B0P B0R B0S B0T ' +
    'B0V B0W B1A B1B B1C B1E B1G B1H B1J B1K B1L B1M ' +
    'B1N B1P B1R B1S B1T B1V B1W B1X B1Y B2A B2C B2E ' +
    'B2G B2H B2J B2N B2R B2S B2T B2V B2W B2X B2Y B2Z ' +
    'B3A B3B B3E B3G B3H B3J B3K B3L B3M B3N B3P B3R ' +
    'B3S B3T B3V B3Z B4A B4B B4C B4E B4G B4H B4N B4P ' +
    'B4R B4V B5A B6L B9A',
  'C': 'C0A C0B C1A C1B C1C C1E C1N',
  'E': 'E1A E1B E1C E1E E1G E1H E1J E1K E1N E1V E1W E1X ' +
    'E2A E2E E2G E2H E2J E2K E2L E2M E2N E2P E2R E2S ' +
    'E2V E3A E3B E3C E3E E3G E3L E3N E3V E3Y E3Z E4A ' +
    'E4B E4C E4E E4G E4H E4J E4K E4L E4M E4N E4P E4R ' +
    'E4S E4T E4V E4W E4X E4Y E4Z E5A E5B E5C E5E E5G ' +
    'E5H E5J E5K E5L E5M E5N E5P E5R E5S E5T E5V E6A ' +
    'E6B E6C E6E E6G E6H E6J E6K E6L E7A E7B E7C E7E ' +
    'E7G E7H E7J E7K E7L E7M E7N E7P E8A E8B E8C E8E ' +
    'E8G E8J E8K E8L E8M E8N E8P E8R E8S E8T E9A E9B ' +
    'E9C E9E E9G E9H',
  'G': 'G0A G0C G0E G0G G0H G0J G0K G0L G0M G0N G0P G0R ' +
    'G0S G0T G0V G0W G0X G0Y G0Z G1A G1B G1C G1E G1G ' +
    'G1H G1J G1K G1L G1M G1N G1P G1R G1S G1T G1V G1W ' +
    'G1X G1Y G2A G2B G2C G2E G2G G2J G2K G2L G2M G2N ' +
    'G3A G3B G3C G3E G3G G3H G3J G3K G3L G3M G3N G3S ' +
    'G3Z G4A G4R G4S G4T G4V G4W G4X G4Z G5A G5B G5C ' +
    'G5H G5J G5L G5M G5N G5R G5T G5V G5X G5Y G5Z G6A ' +
    'G6B G6C G6E G6G G6H G6J G6K G6L G6P G6R G6S G6T ' +
    'G6V G6W G6X G6Y G6Z G7A G7B G7G G7H G7J G7K G7N ' +
    'G7P G7S G7T G7X G7Y G7Z G8A G8B G8C G8E G8G G8H ' +
    'G8J G8K G8L G8M G8N G8P G8T G8V G8W G8Y G8Z G9A ' +
    'G9B G9C G9H G9N G9P G9R G9T G9X',
  'H': 'H0H H0M H1A H1B H1C H1E H1G H1H H1J H1K H1L H1M ' +
    'H1N H1P H1R H1S H1T H1V H1W H1X H1Y H1Z H2A H2B ' +
    'H2C H2E H2G H2H H2J H2K H2L H2M H2N H2P H2R H2S ' +
    'H2T H2V H2W H2X H2Y H2Z H3A H3B H3C H3E H3G H3H ' +
    'H3J H3K H3L H3M H3N H3P H3R H3S H3T H3V H3W H3X ' +
    'H3Y H3Z H4A H4B H4C H4E H4G H4H H4J H4K H4L H4M ' +
    'H4N H4P H4R H4S H4T H4V H4W H4X H4Y H5A H5B H7A ' +
    'H7B H7C H7E H7G H7H H7J H7K H7L H7M H7N H7P H7R ' +
    'H7S H7T H7V H7W H7X H7Y H8N H8P H8R H8S H8T H8Y ' +
    'H8Z H9A H9B H9C H9E H9G H9H H9J H9K H9P H9R H9S ' +
    'H9W H9X',
  'J': 'J0A J0B J0C J0E J0G J0H J0J J0K J0L J0M J0N J0P ' +
    'J0R J0S J0T J0V J0W J0X J0Y J0Z J1A J1C J1E J1G ' +
    'J1H J1J J1K J1L J1M J1N J1R J1S J1T J1X J1Z J2A ' +
    'J2B J2C J2E J2G J2H J2J J2K J2L J2M J2N J2R J2S ' +
    'J2T J2W J2X J2Y J3A J3B J3E J3G J3H J3L J3M J3N ' +
    'J3P J3R J3T J3V J3X J3Y J3Z J4B J4G J4H J4J J4K ' +
    'J4L J4M J4N J4P J4R J4S J4T J4V J4W J4X J4Y J4Z ' +
    'J5A J5B J5C J5J J5K J5L J5M J5N J5R J5T J5V J5W ' +
    'J5X J5Y J5Z J6A J6E J6J J6K J6N J6R J6S J6T J6V ' +
    'J6W J6X J6Y J6Z J7A J7B J7C J7E J7G J7H J7J J7K ' +
    'J7L J7M J7N J7P J7R J7T J7V J7W J7X J7Y J7Z J8A ' +
    'J8B J8C J8E J8G J8H J8L J8M J8N J8P J8R J8T J8V ' +
    'J8X J8Y J8Z J9A J9B J9E J9H J9J J9L J9P J9T J9V ' +
    'J9X J9Y J9Z',
  'K': 'K0A K0B K0C K0E K0G K0H K0J K0K K0L K0M K1A K1B ' +
    'K1C K1E K1G K1H K1J K1K K1L K1M K1N K1P K1R K1S ' +
    'K1T K1V K1W K1X K1Y K1Z K2A K2B K2C K2E K2G K2H ' +
    'K2J K2K K2L K2M K2P K2R K2S K2T K2V K2W K4A K4B ' +
    'K4C K4K K4M K4P K4R K6A K6H K6J K6K K6T K6V K7A ' +
    'K7C K7G K7H K7K K7L K7M K7N K7P K7R K7S K7V K8A ' +
    'K8B K8H K8N K8P K8R K8V K9A K9H K9J K9K K9L K9V',
  'L': 'L0A L0B L0C L0E L0G L0H L0J L0K L0L L0M L0N L0P ' +
    'L0R L0S L1A L1B L1C L1E L1G L1H L1J L1K L1L L1M ' +
    'L1N L1P L1R L1S L1T L1V L1W L1X L1Y L1Z L2A L2E ' +
    'L2G L2H L2J L2M L2N L2P L2R L2S L2T L2V L2W L3B ' +
    'L3C L3E L3J L3K L3L L3M L3P L3R L3S L3T L3V L3W ' +
    'L3X L3Y L3Z L4A L4B L4C L4E L4G L4H L4J L4K L4L ' +
    'L4M L4N L4P L4R L4S L4T L4V L4W L4X L4Y L4Z L5A ' +
    'L5B L5C L5E L5G L5H L5J L5K L5L L5M L5N L5P L5R ' +
    'L5S L5T L5V L5W L6A L6B L6C L6E L6G L6H L6J L6K ' +
    'L6L L6M L6P L6R L6S L6T L6V L6W L6X L6Y L6Z L7A ' +
    'L7B L7C L7E L7G L7J L7K L7L L7M L7N L7P L7R L7S ' +
    'L7T L8B L8E L8G L8H L8J L8K L8L L8M L8N L8P L8R ' +
    'L8S L8T L8V L8W L9A L9B L9C L9E L9G L9H L9J L9K ' +
    'L9L L9M L9N L9P L9R L9S L9T L9V L9W L9X L9Y L9Z',
  'M': 'M1B M1C M1E M1G M1H M1J M1K M1L M1M M1N M1P M1R ' +
    'M1S M1T M1V M1W M1X M2H M2J M2K M2L M2M M2N M2P ' +
    'M2R M3A M3B M3C M3H M3J M3K M3L M3M M3N M4A M4B ' +
    'M4C M4E M4G M4H M4J M4K M4L M4M M4N M4P M4R M4S ' +
    'M4T M4V M4W M4X M4Y M5A M5B M5C M5E M5G M5H M5J ' +
    'M5K M5L M5M M5N M5P M5R M5S M5T M5V M5W M5X M6A ' +
    'M6B M6C M6E M6G M6H M6J M6K M6L M6M M6N M6P M6R ' +
    'M6S M7A M7R M7Y M8V M8W M8X M8Y M8Z M9A M9B M9C ' +
    'M9L M9M M9N M9P M9R M9V M9W',
  'N': 'N0A N0B N0C N0E N0G N0H N0J N0K N0L N0M N0N N0P ' +
    'N0R N1A N1C N1E N1G N1H N1K N1L N1M N1P N1R N1S ' +
    'N1T N2A N2B N2C N2E N2G N2H N2J N2K N2L N2M N2N ' +
    'N2P N2R N2T N2V N2Z N3A N3B N3C N3E N3H N3L N3P ' +
    'N3R N3S N3T N3V N3W N4B N4G N4K N4L N4N N4S N4T ' +
    'N4V N4W N4X N4Z N5A N5C N5H N5L N5P N5R N5V N5W ' +
    'N5X N5Y N5Z N6A N6B N6C N6E N6G N6H N6J N6K N6L ' +
    'N6M N6N N6P N7A N7G N7L N7M N7S N7T N7V N7W N7X ' +
    'N8A N8H N8L N8M N8N N8P N8R N8S N8T N8V N8W N8X ' +
    'N8Y N9A N9B N9C N9E N9G N9H N9J N9K N9V N9Y',
  'P': 'P0A P0B P0C P0E P0G P0H P0J P0K P0L P0M P0N P0P ' +
    'P0R P0S P0T P0V P0W P0X P0Y P1A P1B P1C P1H P1L ' +
    'P1P P2A P2B P2N P3A P3B P3C P3E P3G P3L P3N P3P ' +
    'P3Y P4N P4P P4R P5A P5E P5N P6A P6B P6C P7A P7B ' +
    'P7C P7E P7G P7J P7K P7L P8N P8T P9A P9N',
  'R': 'R0A R0B R0C R0E R0G R0H R0J R0K R0L R0M R1A R1B ' +
    'R1C R1N R2C R2E R2G R2H R2J R2K R2L R2M R2N R2P ' +
    'R2R R2V R2W R2X R2Y R3A R3B R3C R3E R3G R3H R3J ' +
    'R3K R3L R3M R3N R3P R3R R3S R3T R3V R3W R3X R3Y ' +
    'R4A R4B R4G R4H R4J R4K R4L R5A R5G R5H R5J R5K ' +
    'R5L R5M R5N R5P R5R R5T R6M R6P R6T R6W R7A R7B ' +
    'R7C R7N R8A R8N R9A',
  'S': 'S0A S0C S0E S0G S0H S0J S0K S0L S0M S0N S0P S2V ' +
    'S3N S4A S4H S4K S4L S4M S4N S4P S4R S4S S4T S4V ' +
    'S4W S4X S4Y S4Z S6H S6J S6K S6V S6W S6X S7A S7B ' +
    'S7C S7H S7J S7K S7L S7M S7N S7P S7R S7S S7T S7V ' +
    'S7W S9A S9H S9V S9X',
  'T': 'T0A T0B T0C T0E T0G T0H T0J T0K T0L T0M T0P T0V ' +
    'T1A T1B T1C T1G T1H T1J T1K T1L T1M T1P T1R T1S ' +
    'T1V T1W T1X T1Y T1Z T2A T2B T2C T2E T2G T2H T2J ' +
    'T2K T2L T2M T2N T2P T2R T2S T2T T2V T2W T2X T2Y ' +
    'T2Z T3A T3B T3C T3E T3G T3H T3J T3K T3L T3M T3N ' +
    'T3P T3R T3S T3T T3Z T4A T4B T4C T4E T4G T4H T4J ' +
    'T4K T4L T4M T4N T4P T4R T4S T4T T4V T4X T5A T5B ' +
    'T5C T5E T5G T5H T5J T5K T5L T5M T5N T5P T5R T5S ' +
    'T5T T5V T5W T5X T5Y T5Z T6A T6B T6C T6E T6G T6H ' +
    'T6J T6K T6L T6M T6N T6P T6R T6S T6T T6V T6W T6X ' +
    'T6Y T7A T7E T7N T7P T7S T7V T7X T7Y T7Z T8A T8B ' +
    'T8C T8E T8G T8H T8L T8N T8R T8S T8T T8V T8W T8X ' +
    'T9A T9C T9E T9G T9H T9J T9K T9M T9N T9S T9V T9W ' +
    'T9X',
  'V': 'V0A V0B V0C V0E V0G V0H V0J V0K V0L V0M V0N V0P ' +
    'V0R V0S V0T V0V V0W V0X V1A V1B V1C V1E V1G V1H ' +
    'V1J V1K V1L V1M V1N V1P V1R V1S V1T V1V V1W V1X ' +
    'V1Y V1Z V2A V2B V2C V2E V2G V2H V2J V2K V2L V2M ' +
    'V2N V2P V2R V2S V2T V2V V2W V2X V2Y V2Z V3A V3B ' +
    'V3C V3E V3G V3H V3J V3K V3L V3M V3N V3R V3S V3T ' +
    'V3V V3W V3X V3Y V3Z V4A V4B V4C V4E V4G V4K V4L ' +
    'V4M V4N V4P V4R V4S V4T V4V V4W V4X V4Y V4Z V5A ' +
    'V5B V5C V5E V5G V5H V5J V5K V5L V5M V5N V5P V5R ' +
    'V5S V5T V5V V5W V5X V5Y V5Z V6A V6B V6C V6E V6G ' +
    'V6H V6J V6K V6L V6M V6N V6P V6R V6S V6T V6V V6W ' +
    'V6X V6Y V6Z V7A V7B V7C V7E V7G V7H V7J V7K V7L ' +
    'V7M V7N V7P V7R V7S V7T V7V V7W V7X V7Y V7Z V8A ' +
    'V8B V8C V8E V8G V8H V8J V8K V8L V8M V8N V8P V8R ' +
    'V8S V8T V8V V8W V8X V8Y V8Z V9A V9B V9C V9E V9G ' +
    'V9H V9J V9K V9L V9M V9N V9P V9R V9S V9T V9V V9W ' +
    'V9X V9Y V9Z',
  'X': 'X0A X0B X0C X0E X0G X1A',
  'Y': 'Y0A Y0B Y1A',
};

/* First letter -> province/territory for every district except X
 * (shared: X0A/X0B/X0C are Nunavut, X0E/X0G/X1A the Northwest
 * Territories) — settled per FSA in giftFsaProvince. */
const GIFT_FSA_PROVINCE = { A: 'NL', B: 'NS', C: 'PE', E: 'NB', G: 'QC', H: 'QC', J: 'QC',
  K: 'ON', L: 'ON', M: 'ON', N: 'ON', P: 'ON', R: 'MB', S: 'SK', T: 'AB', V: 'BC', Y: 'YT' };
const GIFT_PROVINCE_NAMES = { NL: 'Newfoundland and Labrador', NS: 'Nova Scotia',
  PE: 'Prince Edward Island', NB: 'New Brunswick', QC: 'Quebec', ON: 'Ontario',
  MB: 'Manitoba', SK: 'Saskatchewan', AB: 'Alberta', BC: 'British Columbia',
  YT: 'Yukon', NT: 'Northwest Territories', NU: 'Nunavut' };

function giftFsaKnown(fsa) {
  const list = GIFT_FSA_BY_LETTER[String(fsa || '').charAt(0)];
  return !!list && (' ' + list + ' ').indexOf(' ' + fsa + ' ') >= 0;
}
function giftFsaCount() {
  return Object.keys(GIFT_FSA_BY_LETTER).reduce((n, k) => n + GIFT_FSA_BY_LETTER[k].split(' ').length, 0);
}
/* Province for an FSA, or null when the FSA is not in the vendored set.
 * K1A is the federal-government district: it legitimately serves both
 * Ontario and Quebec addresses, so it reports 'ON/QC'. */
function giftFsaProvince(fsa) {
  fsa = String(fsa || '').toUpperCase();
  if (!giftFsaKnown(fsa)) return null;
  if (fsa === 'K1A') return 'ON/QC';
  if (fsa.charAt(0) === 'X') return (fsa === 'X0E' || fsa === 'X0G' || fsa === 'X1A') ? 'NT' : 'NU';
  return GIFT_FSA_PROVINCE[fsa.charAt(0)] || null;
}

/* Free-text province/state -> province code, or null when unrecognized.
 * Accepts English and French names, postal abbreviations, and loose
 * punctuation/casing — the region field stays free text. */
function giftRegionProvince(region) {
  const s = String(region || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const table = {
    'nl': 'NL', 'newfoundland and labrador': 'NL', 'newfoundland': 'NL', 'labrador': 'NL', 'terre neuve et labrador': 'NL', 'terre neuve': 'NL',
    'ns': 'NS', 'nova scotia': 'NS', 'nouvelle ecosse': 'NS',
    'pe': 'PE', 'pei': 'PE', 'prince edward island': 'PE', 'ile du prince edouard': 'PE',
    'nb': 'NB', 'new brunswick': 'NB', 'nouveau brunswick': 'NB',
    'qc': 'QC', 'quebec': 'QC',
    'on': 'ON', 'ontario': 'ON',
    'mb': 'MB', 'manitoba': 'MB',
    'sk': 'SK', 'saskatchewan': 'SK',
    'ab': 'AB', 'alberta': 'AB',
    'bc': 'BC', 'british columbia': 'BC', 'colombie britannique': 'BC',
    'yt': 'YT', 'yukon': 'YT',
    'nt': 'NT', 'northwest territories': 'NT', 'territoires du nord ouest': 'NT',
    'nu': 'NU', 'nunavut': 'NU',
  };
  return table[s] || null;
}

const GIFT_COUNTRY_ALIASES = { 'USA': 'US', 'U S A': 'US', 'UNITED STATES OF AMERICA': 'US',
  'UK': 'GB', 'U K': 'GB', 'GREAT BRITAIN': 'GB', 'ENGLAND': 'GB', 'SCOTLAND': 'GB', 'WALES': 'GB' };
/* Resolve a stored country value (today's rows hold free text like
 * 'Canada' or 'CA') to an ISO code, or '' when it matches nothing. */
function giftCountryCodeFor(stored) {
  const raw = String(stored || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && GIFT_COUNTRIES.some(c => c[0] === upper)) return upper;
  const squashed = upper.replace(/[^A-Z]+/g, ' ').trim();
  if (GIFT_COUNTRY_ALIASES[squashed]) return GIFT_COUNTRY_ALIASES[squashed];
  const lower = raw.toLowerCase();
  const hit = GIFT_COUNTRIES.find(c => c[1].toLowerCase() === lower);
  return hit ? hit[0] : '';
}

function giftPostalBlock(message) { return { status: 'block', normalized: '', message }; }

/* The validator. Returns { status, normalized, message }:
 *  - 'block': malformed for the country's format — cannot be a real
 *    code; the form must not save until it is fixed.
 *  - 'warn' : plausible but doubtful (CA: FSA unknown to the vendored
 *    set, or FSA province disagrees with the entered province) — the
 *    form may save only via an explicit "Save anyway".
 *  - 'ok'   : well-formed (and, for CA, consistent); `normalized` is
 *    the tidy value that rides the save payload.
 *  - 'skip' : nothing to check (empty field, no-postal-system country,
 *    or a country with no vendored format) — save proceeds untouched.
 * Advisory UI only: no verdict is ever stored or sent. */
function giftPostalCheck(countryCode, postalRaw, regionRaw) {
  const raw = String(postalRaw == null ? '' : postalRaw).trim();
  if (!raw) return { status: 'skip', normalized: raw, message: '' };
  const cc = String(countryCode || '').toUpperCase();
  if (cc === 'CA') return giftPostalCheckCA(raw, regionRaw);
  if (cc === 'US') {
    const z = raw.replace(/\s+/g, '');
    if (/^\d{5}$/.test(z)) return { status: 'ok', normalized: z, message: '' };
    if (/^\d{9}$/.test(z)) return { status: 'ok', normalized: z.slice(0, 5) + '-' + z.slice(5), message: '' };
    if (/^\d{5}-\d{4}$/.test(raw)) return { status: 'ok', normalized: raw, message: '' };
    return giftPostalBlock('That doesn’t look like a US ZIP code — it should be 5 digits, like 90210, or 90210-1234.');
  }
  if (GIFT_NO_POSTAL[cc]) return { status: 'skip', normalized: raw, message: '' };
  const fmt = GIFT_POSTAL_FORMATS[cc];
  if (typeof fmt !== 'string' || !fmt) return { status: 'skip', normalized: raw, message: '' };
  let re;
  try { re = new RegExp('^(?:' + fmt + ')$', 'i'); } catch (e) { return { status: 'skip', normalized: raw, message: '' }; }
  if (re.test(raw)) return { status: 'ok', normalized: raw, message: '' };
  return giftPostalBlock('That doesn’t look like a postal code for the selected country — please check it and try again.');
}

function giftPostalCheckCA(raw, regionRaw) {
  const squashed = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const blockMsg = 'That doesn’t look like a Canadian postal code — it should look like E1C 1A1.';
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(squashed)) return giftPostalBlock(blockMsg);
  /* Canada Post letter rules: D, F, I, O, Q, U never appear in any
   * letter position; W and Z never appear in the first position. */
  const letters = [squashed.charAt(0), squashed.charAt(2), squashed.charAt(4)];
  if (letters.some(l => 'DFIOQU'.indexOf(l) >= 0)) return giftPostalBlock(blockMsg);
  if (squashed.charAt(0) === 'W' || squashed.charAt(0) === 'Z') return giftPostalBlock(blockMsg);
  const normalized = squashed.slice(0, 3) + ' ' + squashed.slice(3);
  const fsa = squashed.slice(0, 3);
  const prov = giftFsaProvince(fsa);
  if (!prov) {
    return { status: 'warn', normalized, message: 'We couldn’t find that postal code area in our list — it may be brand new. You can save it anyway if it looks right.' };
  }
  const regionProv = giftRegionProvince(regionRaw);
  if (regionProv && prov !== 'ON/QC' && prov !== regionProv) {
    return { status: 'warn', normalized, message: 'That postal code is in ' + (GIFT_PROVINCE_NAMES[prov] || prov) +
      ', but the province or territory says ' + String(regionRaw || '').trim() + '. You can save it anyway if it’s right.' };
  }
  return { status: 'ok', normalized, message: '' };
}

