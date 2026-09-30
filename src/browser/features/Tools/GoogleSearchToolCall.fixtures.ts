/**
 * Sample of Google's searchEntryPoint.renderedContent as returned by the
 * server:GOOGLE_SEARCH_WEB grounding tool result ({ search_suggestions }).
 *
 * The style block is abridged, but the structure matches the wire payload: a <style>
 * block keyed off prefers-color-scheme, a container with Google's logo SVGs, and one
 * <a class="chip" href="https://www.google.com/search?q=…"> per query.
 *
 * Shared by GoogleSearchToolCall tests and stories; never imported by product code.
 */

export const SAMPLE_GOOGLE_SEARCH_QUERIES = [
  "electron 34 release date",
  "electron 34 breaking changes",
  "electron 34 chromium version",
];

export const SAMPLE_SEARCH_SUGGESTIONS_HTML = `<style>
.container {
  align-items: center;
  border-radius: 8px;
  display: flex;
  font-family: Google Sans, Roboto, sans-serif;
  font-size: 14px;
  line-height: 20px;
  padding: 8px 12px;
}
.chip {
  display: inline-block;
  border: solid 1px;
  border-radius: 16px;
  min-width: 14px;
  padding: 5px 16px;
  text-align: center;
  user-select: none;
  margin: 0 8px;
}
.carousel {
  overflow: auto;
  scrollbar-width: none;
  white-space: nowrap;
  padding-right: 12px;
}
.headline {
  display: flex;
  margin-right: 4px;
}
@media (prefers-color-scheme: light) {
  .container { background-color: #fafafa; box-shadow: 0 0 0 1px #0000000f; }
  .chip { background-color: #ffffff; border-color: #d2d2d2; color: #5e5e5e; }
  .logo-dark { display: none; }
}
@media (prefers-color-scheme: dark) {
  .container { background-color: #1f1f1f; box-shadow: 0 0 0 1px #ffffff26; }
  .chip { background-color: #2c2c2c; border-color: #3c4043; color: #fff; }
  .logo-light { display: none; }
}
</style>
<div class="container">
  <div class="headline">
    <svg class="logo-light" width="18" height="18" viewBox="9 9 35 35" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill="#4285F4" d="M42.81 26.92c0-1.33-.11-2.6-.32-3.83H26.5v7.24h9.14a7.81 7.81 0 0 1-3.39 5.13v4.26h5.49c3.21-2.96 5.07-7.32 5.07-12.8Z"></path>
    </svg>
    <svg class="logo-dark" width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="23" fill="#FFF" r="22"></circle>
    </svg>
  </div>
  <div class="carousel">
    <a class="chip" href="https://www.google.com/search?q=electron+34+release+date">electron 34 release date</a>
    <a class="chip" href="https://www.google.com/search?q=electron+34+breaking+changes">electron 34 breaking changes</a>
    <a class="chip" href="https://www.google.com/search?q=electron+34+chromium+version">electron 34 chromium version</a>
  </div>
</div>
`;
