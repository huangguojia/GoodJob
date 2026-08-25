# WhatsApp CRM Plugin Design System

## Product Character

This is an operational CRM messaging console. It uses a light, dense workspace with stable split panes. The interface prioritizes account identity, delivery safety, message visibility and actionable error states over decorative presentation.

Reference principles:

- Linear: compact navigation, restrained surfaces and precise interaction states.
- Sentry: explicit degraded/error diagnostics and retry affordances.
- Supabase: clean provider configuration, secret masking and technical clarity.

## Tokens

- Canvas: `#f6f7f8`; primary surface: `#ffffff`; secondary surface: `#f1f3f4`.
- Ink: `#18201d`; muted and faint ink: `#68726d`; hairline: `#dde2df`.
- Primary action: accessible WhatsApp green `#168044`; hover `#116d36`.
- Semantic states: success `#1f8f50`, warning `#b7791f`, danger `#c4413b`, info `#3178c6`.
- Radius: 4px for tags, 6px for inputs/buttons, 8px maximum for panels and dialogs.
- Type: system sans; 13px default workspace copy, 11-12px metadata, 14-18px compact panel headings. Operational text never drops below 10px.
- Letter spacing is always `0`.

## Layout

- Desktop workspace: 56px account rail, 300px conversation list, flexible chat, 300px inspector.
- The currently sending account remains visible in the chat header and composer.
- At 1180px and below the inspector becomes an explicit right drawer; mobile also turns the account rail into a top selector and makes conversation/chat sequential views.
- The shell uses dynamic viewport height and safe-area padding so mobile browser chrome and keyboards do not cover primary actions.
- Panels use hairline borders. Page sections are not floating cards and cards are never nested.

## Interaction

- Icon-only tools use Lucide icons with `title`/accessible labels.
- Automatic translation is a switch. Target language is a select. Manual translation is a per-message `Languages` action.
- Connection and translation failures show a concise cause, last attempt and retry command.
- Pending translation reserves vertical space so the message list does not jump.
- Empty states always provide the next operational command.
- Keyboard focus uses a solid blue 2px ring. Icon-only navigation always carries a title and accessible name.
- Prototype stage labels are not shown in the production shell; Demo-only prompts appear only while a Demo account exists.
