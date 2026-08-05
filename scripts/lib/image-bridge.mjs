// Client for apps-script/image-bridge.gs. Entirely optional: if the bridge isn't
// configured (no URL in env), every function here degrades to "no images found" so the
// rest of the sync job runs exactly as it did before this existed. See README "Apps
// Script image bridge" for one-time setup.

export function isImageBridgeConfigured() {
  return Boolean(process.env.APPS_SCRIPT_IMAGE_BRIDGE_URL && process.env.APPS_SCRIPT_SHARED_SECRET);
}

// Returns { [sheetName]: [{ row, column }, ...] } (both 1-indexed, matching Sheets' own
// numbering), or an empty object if the bridge isn't configured or the call fails --
// callers should treat that as "no known images" rather than an error, since detecting
// these photos is a nice-to-have layered on top of a pipeline that works without it.
export async function fetchImageAnchorsByTab(spreadsheetId, sheetNames) {
  if (!isImageBridgeConfigured()) return {};

  const url = new URL(process.env.APPS_SCRIPT_IMAGE_BRIDGE_URL);
  url.searchParams.set('secret', process.env.APPS_SCRIPT_SHARED_SECRET);
  url.searchParams.set('spreadsheetId', spreadsheetId);
  url.searchParams.set('sheetNames', sheetNames.join(','));

  try {
    const res = await fetch(url.toString());
    const json = await res.json();
    if (json.error) {
      console.warn(`[sync] image bridge returned an error, continuing without photo detection: ${json.error}`);
      return {};
    }
    return json.data || {};
  } catch (err) {
    console.warn(`[sync] image bridge call failed, continuing without photo detection: ${err.message}`);
    return {};
  }
}

// Small tolerance for manual placement imprecision (an image dragged slightly off its
// intended cell) -- still far enough from other photo columns (Outfit Image sits several
// columns away from Size & Measurements on every tab) that this can't cross-match them.
const TOLERANCE = 1;

export function hasImageNear(anchors, sheetRow1Indexed, column1Indexed) {
  return anchors.some(
    (a) => Math.abs(a.row - sheetRow1Indexed) <= TOLERANCE && Math.abs(a.column - column1Indexed) <= TOLERANCE,
  );
}
