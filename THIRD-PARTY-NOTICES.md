# Third-party components

NoFridayMail ships no third-party binaries. The deployed site and the managed API bundle or install the following npm packages at build time (`npm ci`, `npm ci --omit=dev` for the API); the exact versions are pinned by `package-lock.json` and `api/package-lock.json`. Development tools (webpack, ajv, adm-zip, the Office add-in tooling and their dependencies) are used to build and test and are not part of what is deployed.

| Component | Version | Used by | License |
|---|---|---|---|
| @azure/msal-browser (Microsoft) | 4.30.0 | Task pane, only for environments that enable the MFA step (`bypass.mfa.required`); never in `launchevent.js` | MIT — https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/LICENSE |
| @azure/msal-common (Microsoft) | 15.17.0 | Dependency of @azure/msal-browser | MIT |
| jose (Filip Skokan) | 5.10.0 | Managed API: validation of the Microsoft Entra ID token, signed receipt | MIT — https://github.com/panva/jose/blob/main/LICENSE.md |
| @azure/functions (Microsoft) | 4.17.0 | Managed API: Azure Functions v4 programming model | MIT — https://github.com/Azure/azure-functions-nodejs-library/blob/v4.x/LICENSE |
| @azure/functions-extensions-base (Microsoft) | 0.3.0 | Dependency of @azure/functions | MIT |
| cookie (Roman Shtylman) | 0.7.2 | Dependency of @azure/functions | MIT — https://github.com/jshttp/cookie/blob/master/LICENSE |

The Office.js library is loaded by Outlook from Microsoft's content delivery network at run time and is not redistributed here. The fonts and icons of the task pane are system fonts and the project's own SVG drawings.
