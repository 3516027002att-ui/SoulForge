# Parser research boundary

SoulForge must not copy Smithbox, DSMapStudio, DarkScript3, or SoulsFormats implementation code.

The bridge parser policy is:

- use public projects only to identify format families and workflow boundaries;
- write SoulForge parsers as small, audited, read-only components first;
- keep binary envelope inspection separate from semantic extraction;
- require fixtures before claiming authoritative DCX, BND, EMEVD, MSB, PARAM, or FMG parsing;
- return `partial` or `unsupported` honestly when evidence is insufficient.

Initial parser stages:

1. envelope inspection: magic, extension chain, visible section tags, readable strings;
2. container boundary: DCX and BND are recognized before inner parsing;
3. raw text/message fallback: export conservative message entries from readable raw strings only;
4. semantic parsers: implement one format at a time with fixtures and validation.
