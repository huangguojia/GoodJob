# Third-Party Notices

GoodJob CRM may be used commercially. Commercial use does not remove the
obligations of the licenses below. The exact dependency versions are pinned
in `package-lock.json` and `whatsapp-plugin/package-lock.json`. The full
license texts included in this distribution are under `LICENSES/`.

## Communication and WhatsApp components

| Component | Version | Upstream | License | Role |
| --- | --- | --- | --- | --- |
| `whatsapp-web.js` | 1.34.7 | [wwebjs/whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) | Apache-2.0 | Legacy CRM backend Web client and QR/session integration |
| `@whiskeysockets/baileys` | 7.0.0-rc13 | [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) | MIT | Communication Web protocol provider |
| `libsignal` | 6.0.0 | [WhiskeySockets/libsignal-node](https://github.com/WhiskeySockets/libsignal-node) | GPL-3.0 | Signal protocol runtime used by Baileys |
| `node-webpmux` | 3.2.1 | [ApeironTsuka/node-webpmux](https://github.com/ApeironTsuka/node-webpmux) | LGPL-3.0-or-later | Transitive media dependency of `whatsapp-web.js` |
| `twilio` | 6.0.2 | [twilio/twilio-node](https://github.com/twilio/twilio-node) | MIT | Optional official WhatsApp Business API transport |

The Communication service was integrated from the local `CRM系统对接`
working copy. That working copy had no upstream commit or remote configured;
therefore its original application code is attributed to the GoodJob project
contributors, while the protocol and crypto components above remain the
property of their upstream authors.

## Other dependencies

The CRM and Communication applications also use React, Express, Vite,
PostgreSQL/MySQL clients, Socket.IO, Lucide, BullMQ and other packages. Their
copyright and license notices remain in the installed package trees and are
identified by the two lockfiles. Redistributing a built package must retain
the corresponding package license files and this notice.

## Platform and trademark notice

WhatsApp and Meta are not open-source components of this project. Use of
WhatsApp Web or Meta Graph API remains subject to the applicable WhatsApp,
Meta and platform terms, policies, account restrictions, templates and
privacy obligations. This project does not claim affiliation with Meta.

## License obligations in practical terms

- Apache-2.0 and MIT permit commercial use, modification and redistribution
  when the required copyright and license notices are retained.
- LGPL-3.0-or-later permits commercial use, but preserves the library's
  relinking and notice rights.
- GPL-3.0 requires that the covered Communication distribution provide the
  corresponding source and preserve GPL terms. Do not relicense the
  Communication service as proprietary or under Apache-only terms.
