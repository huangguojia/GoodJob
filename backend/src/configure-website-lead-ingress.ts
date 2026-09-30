import { stdin } from "node:process";
import { writeWebsiteLeadIngressSettings } from "./website-lead-ingress-settings.js";

let source = "";
for await (const chunk of stdin) source += String(chunk);

if (!source.trim()) {
  throw new Error("Provide the ingress configuration as JSON on standard input. Secrets must not be passed as command-line arguments.");
}

const result = writeWebsiteLeadIngressSettings(JSON.parse(source));
console.log(JSON.stringify({ configured: true, ...result }, null, 2));

