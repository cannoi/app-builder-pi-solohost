/**
 * Compact few-shot product shapes for code generation (not full file dumps).
 * Keeps prompts small while showing the expected depth.
 */
export const FEW_SHOT_PRODUCTS = `
EXAMPLE A — Task list (depth target):
- public/index.html: title, short help text, form (input+Add), list area, empty state message
- server.js: express, GET /health, GET/POST /api/items, JSON file or sqlite under data/
- User can add an item and see it listed without refreshing instructions only

EXAMPLE B — Simple quiz:
- Home explains the quiz; question screen with choices; result screen with score
- POST /api/attempt stores score; GET /health ok
- Empty/error copy when no attempt yet

EXAMPLE C — Mini landing + contact form:
- Hero + 3 benefit bullets + form name/message
- POST /api/messages; list last messages for operator on /admin or same page section
- Not a single <h1>name</h1> page

Anti-patterns (do not emit):
- Only package.json + Dockerfile + "Welcome {name}"
- Buttons that do nothing; "Coming soon" as the only body text
- Health route without any product route
`;

export function fewShotBlock() {
  return FEW_SHOT_PRODUCTS.trim();
}
