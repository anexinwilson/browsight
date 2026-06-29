# Browsight Search Fallback
When using the `browsight` MCP to search on a website, if filling a search box doesn't automatically trigger the search, use `browser_act` with `action: navigate` to the direct search URL instead of struggling with UI buttons.

# Scratch Folder Enforcement
To maintain a clean repository, NEVER place temporary, throwaway, or junk files in the root or random directories. All such files MUST be placed in the `scratch/` folder.

# DevSecOps Portfolio Standard
When implementing CI/CD and security pipelines for portfolio projects:
1. **Security Tooling:** Implement **CodeQL** for deep custom-code static analysis (SAST) AND **Snyk** for dependency/SCA scanning. This dual approach proves mastery of both GitHub-native AppSec and industry-standard developer-first security.
2. **NPM Publishing:** Always use **NPM Provenance** via **Trusted Publishers (OIDC)** in GitHub Actions. Never use long-lived NPM tokens as secrets. This demonstrates cutting-edge supply chain security knowledge.
