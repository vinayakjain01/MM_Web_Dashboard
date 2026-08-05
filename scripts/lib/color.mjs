// Row-color classification. The ops team manually highlights a whole order row: red for
// cancelled, green for dispatched, no fill for no update yet. Classified by dominant
// channel rather than exact hex match, since the picked shade isn't pure (validated
// against the live sheet: seen as {green:1} and {red:1} -- i.e. full-saturation -- but
// this tolerance protects against any less-saturated pick too).
export function classifyRowColor(bg) {
  if (!bg) return 'No Update'; // Sheets omits the key entirely when a cell has no fill
  const { red = 0, green = 0, blue = 0 } = bg;
  if (red > 0.7 && red > green + 0.2 && red > blue + 0.2) return 'Cancelled';
  if (green > 0.5 && green > red + 0.2 && green > blue + 0.2) return 'Dispatched';
  return 'No Update';
}
