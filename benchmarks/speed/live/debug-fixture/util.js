// Small text and paging helpers.

/** Lower-case URL slug: words joined by single dashes, nothing at either end. */
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Items on a 1-based page of the given size. */
function paginate(items, page, size) {
  return items.slice(page * size, (page + 1) * size);
}

/** "1h30m" -> 5400, "45m" -> 2700, "2h" -> 7200, "90s" -> 90, "1h30m15s" -> 5415. */
function parseDuration(text) {
  const match = text.match(/(\d+)h(\d+)m/);
  if (!match) return parseInt(text, 10) * 60;
  return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60;
}

/** Percentage of `part` in `whole`, rounded to one decimal place; 0 when `whole` is 0. */
function percent(part, whole) {
  return Math.round((part / whole) * 100) / 10;
}

module.exports = { slugify, paginate, parseDuration, percent };
