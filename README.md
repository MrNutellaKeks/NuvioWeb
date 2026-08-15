<div align="center">

  <img src="assets/brand/app_logo_wordmark.png" alt="NuvioTV Web" width="300" />
  <br />
  <br />

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![License][license-shield]][license-url]

  <p>
    A modern TV web app for Samsung Tizen and LG webOS powered by the Stremio addon ecosystem.
    <br />
    Shared web app • Tizen • webOS • Desktop installer • Playback-focused experience
  </p>

</div>

> ⚠️ **This fork (`MrNutellaKeks/NuvioWeb`) is a specialized build for Samsung Tizen 4 (2018 TVs, Chromium 56).**
>
> - **Use this fork only if you target Tizen 4 / 2018 Samsung TVs.**
> - **For all other platforms (Tizen 5+, webOS, desktop, general development), use the upstream repository:** [NuvioMedia/NuvioWeb](https://github.com/NuvioMedia/NuvioWeb)
>
> This fork contains aggressive performance optimizations for Chromium 56:
>
> - Reduced item limits (rows, catalog, continue watching)
> - Disabled spring-scroll animations (snap-only scrolling)
> - Disabled progressive rendering to avoid rAF contention
> - Increased background render delays
> - Tizen 4 detection via `Platform.isTizen4()`

## About

NuvioTV Web is the web codebase for the Nuvio TV experience on Smart TVs.

It powers TV builds for **Samsung Tizen** and **LG webOS**, while also running as a normal browser-based web app during development.

NuvioTV Web acts as a client-side playback interface that can integrate with the Stremio addon ecosystem for content discovery and source resolution through user-installed extensions.

The project is optimized for a TV-first experience, with remote-control navigation, platform-specific playback handling, and packaged builds for supported TV ecosystems.

## Installation

### Compatibility requirement

This fork officially supports **Samsung Tizen TVs from 2018 onward (Tizen 4.0+, Chromium 56)**.

The upstream repository [NuvioMedia/NuvioWeb](https://github.com/NuvioMedia/NuvioWeb) supports:

- Samsung Tizen TVs from 2018 onward
- LG webOS TVs from 2020 onward

### Nuvio WebTV Installer

Download the latest Windows, macOS, or Linux `Nuvio WebTV Installer` build from [GitHub Releases](https://github.com/NuvioMedia/NuvioWeb/releases/latest).

The installer can connect to supported Samsung Tizen and LG webOS TVs and install the latest `.wgt` and `.ipk` packages automatically.

#### macOS note

Current public macOS installer builds may be unsigned. If macOS blocks the app or reports that it is damaged, move the app to `Applications` and run:

```bash
xattr -dr com.apple.quarantine "/Applications/Nuvio WebTV Installer.app"
codesign --force --deep --sign - "/Applications/Nuvio WebTV Installer.app"
open "/Applications/Nuvio WebTV Installer.app"
```

This workaround should only be temporary. Once signed macOS builds are available, this manual step will no longer be needed.

#### Linux note

Current Linux builds are distributed as an AppImage. Make it executable before opening it:

```bash
chmod +x Nuvio-WebTV-Installer-Linux-*.AppImage
./Nuvio-WebTV-Installer-Linux-*.AppImage
```

### Samsung Tizen

> **Note:** This fork builds **only for Tizen 4 (2018 TVs, Chromium 56)**. For newer Tizen versions, use the upstream.

#### TizenBrew

- Open TizenBrew on your Samsung TV.
- Add the GitHub module `NuvioMedia/NuvioTVTizen`.
- Launch Nuvio TV from your installed modules.

#### Manual WGT install

Download the latest `.wgt` package from [GitHub Releases](https://github.com/MrNutellaKeks/NuvioWeb/releases/latest) and install it with your preferred Samsung/Tizen development workflow.

> ⚠️ Releases in this fork contain only Tizen 4 builds. For webOS and newer Tizen, see upstream releases.

### LG webOS

> **Note:** This fork does **not support webOS**. For webOS, use the upstream: [NuvioMedia/NuvioWeb](https://github.com/NuvioMedia/NuvioWeb).

#### Homebrew Channel

- Open `Homebrew Channel` on your LG webOS TV.
- Go to `Settings`.
- Choose `Add repository`.
- Enter:

```text
https://raw.githubusercontent.com/NuvioMedia/NuvioTVWebOS/main/webosbrew/apps.json
```

- Return to the apps list and install Nuvio TV.

#### Manual IPK install

Download the latest `.ipk` package from [Upstream GitHub Releases](https://github.com/NuvioMedia/NuvioWeb/releases/latest).

Enable Developer Mode and Key Server by following the webOS Homebrew guide:

```text
https://www.webosbrew.org/devmode
```

Then install the package with webOS Dev Manager or your preferred webOS development workflow.

## Platform Repositories

- TizenBrew wrapper (Upstream): `NuvioMedia/NuvioTVTizen`
- webOS metadata repository (Upstream): `NuvioMedia/NuvioTVWebOS`
- Desktop installer (Upstream): `NuvioMedia/NuvioWebTVInstaller`

> This fork has no own wrapper repos. For Tizen 4, use the upstream wrapper `NuvioMedia/NuvioTVTizen` (works with the `.wgt` built here).

## Development

### Prerequisites

- Node.js
- npm
- Python 3, for local static hosting
- Tizen Studio, only if building or installing Tizen packages manually
- webOS CLI tools, only if building or installing webOS packages manually

### Setup

```bash
# This fork (Tizen 4 only)
git clone https://github.com/MrNutellaKeks/NuvioWeb.git
cd NuvioWeb
npm install
```

> For full development (Tizen 5+, webOS, Desktop), clone the upstream:
>
> ```bash
> git clone https://github.com/NuvioMedia/NuvioWeb.git
> ```

### Run the Web App Locally

```bash
npm run build
python3 -m http.server 8080 -d dist
```

Open:

```text
http://127.0.0.1:8080
```

## Project Structure

- `js/` contains app logic, UI screens, platform adapters, and player code.
- `css/` contains shared styling and TV layout rules.
- `assets/` contains icons, branding, and bundled assets.
- `docs/` contains static runtime helper pages used by the app.
- `scripts/` contains build, packaging, sync, and metadata tooling.
- `dist/` contains generated build output.

## Building TV Packages

### webOS

> ⚠️ **webOS builds are disabled in this fork.** Use the upstream for webOS development and builds.

[Upstream webOS Build Instructions](https://github.com/NuvioMedia/NuvioWeb#webos)

### Tizen

Build a local `.wgt` package directly from this repository:

```bash
npm run package:tizen
```

The package is generated in the repository root using the current app version.

Default identifiers:

- Tizen package id: `NuvioTV`
- Tizen application id: `NuvioTV.NuvioTV`

You can override them when needed:

```bash
TIZEN_PACKAGE_ID=NuvioTV TIZEN_APP_ID=NuvioTV.NuvioTV npm run package:tizen
```

To package with a specific properties file:

```bash
npm run package:tizen -- --env-source /absolute/path/to/local.properties
```

> ⚠️ This command builds **only Tizen 4**. For webOS builds, use the upstream.

## Syncing Custom Wrapper Projects

The shared app can also be synced into external Tizen or webOS wrapper projects.

### webOS wrapper

Create a webOS project folder with at least:

```text
YourWebOSProject/
  appinfo.json
  index.html
  main.js
```

Then run:

```bash
npm run build
npm run sync:webos -- /absolute/path/to/YourWebOSProject
```

### Tizen wrapper

Create a Tizen project folder with at least:

```text
YourTizenProject/
  config.xml
  index.html
  main.js
```

Then run:

```bash
npm run build
npm run sync:tizen -- /absolute/path/to/YourTizenProject
```

Compatibility form:

```bash
npm run sync -- --webos --path /absolute/path/to/project
npm run sync -- --tizen --path /absolute/path/to/project
```

## Hosted vs Packaged

NuvioTV Web can run in different deployment modes:

- Hosted as a normal web app.
- Packaged as a Samsung Tizen `.wgt`.
- Packaged as an LG webOS `.ipk`.
- Installed through the Nuvio WebTV Installer.
- Used through platform wrapper repositories such as TizenBrew and webOS Homebrew.

The shared web app remains the source of truth for the TV experience across these targets.

## Origins / Credits

This project is part of the Nuvio TV ecosystem and builds on important community work:

- **tapframe/NuvioTV**  
  The original Android TV project that shaped the TV-first product direction.  
  https://github.com/tapframe/NuvioTV

- **WhiteGiso/NuvioTV-WebOS**  
  The community webOS codebase that served as an early inspiration and base for this shared web version.  
  https://github.com/WhiteGiso/NuvioTV-WebOS

NuvioTV Web expands that foundation into a shared smart TV web app for Samsung Tizen and LG webOS.

## Legal & DMCA

NuvioTV Web functions solely as a client-side interface for browsing metadata and playing media provided by user-installed extensions and/or user-provided sources. It is intended for content the user owns or is otherwise authorized to access.

NuvioTV Web is not affiliated with any third-party extensions, catalogs, sources, or content providers. It does not host, store, or distribute any media content.

For comprehensive legal information, including our full disclaimer, third-party extension policy, and DMCA/Copyright information, please visit our [Legal & Disclaimer Page](https://nuvioapp.space/legal).

## Built With

- JavaScript
- HTML
- CSS
- Samsung Tizen Web APIs
- LG webOS APIs
- Node.js build tooling
- Stremio addon ecosystem

## Star History

<a href="https://www.star-history.com/?repos=mrnutellakeks%2Fnuvioweb&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=mrnutellakeks/nuvioweb&type=date&theme=dark&legend=top-left&sealed_token=7yPpviZ_jp4B2uov92vTzey5xrCxPY7QAv35OL9h1D9o1zuOY7sF4YpscBB-15XwZl1golPV-IuY55E-ld6n0891xES6lvauTDBfT5ApUdGcKDiIdA2CDXEGtVMYzpi2fMbT5-uk1bDv28Of15lH5nDv-TpD-uDGZy14IEKfBg3kA_hsXUvgnVRiead1" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=mrnutellakeks/nuvioweb&type=date&legend=top-left&sealed_token=7yPpviZ_jp4B2uov92vTzey5xrCxPY7QAv35OL9h1D9o1zuOY7sF4YpscBB-15XwZl1golPV-IuY55E-ld6n0891xES6lvauTDBfT5ApUdGcKDiIdA2CDXEGtVMYzpi2fMbT5-uk1bDv28Of15lH5nDv-TpD-uDGZy14IEKfBg3kA_hsXUvgnVRiead1" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=mrnutellakeks/nuvioweb&type=date&legend=top-left&sealed_token=7yPpviZ_jp4B2uov92vTzey5xrCxPY7QAv35OL9h1D9o1zuOY7sF4YpscBB-15XwZl1golPV-IuY55E-ld6n0891xES6lvauTDBfT5ApUdGcKDiIdA2CDXEGtVMYzpi2fMbT5-uk1bDv28Of15lH5nDv-TpD-uDGZy14IEKfBg3kA_hsXUvgnVRiead1" />
 </picture>
</a>

<!-- MARKDOWN LINKS & IMAGES -->

[contributors-shield]: https://img.shields.io/github/contributors/NuvioMedia/NuvioWeb.svg?style=for-the-badge
[contributors-url]: https://github.com/NuvioMedia/NuvioWeb/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/NuvioMedia/NuvioWeb.svg?style=for-the-badge
[forks-url]: https://github.com/NuvioMedia/NuvioWeb/network/members
[stars-shield]: https://img.shields.io/github/stars/NuvioMedia/NuvioWeb.svg?style=for-the-badge
[stars-url]: https://github.com/NuvioMedia/NuvioWeb/stargazers
[issues-shield]: https://img.shields.io/github/issues/NuvioMedia/NuvioWeb.svg?style=for-the-badge
[issues-url]: https://github.com/NuvioMedia/NuvioWeb/issues
[license-shield]: https://img.shields.io/github/license/NuvioMedia/NuvioWeb.svg?style=for-the-badge
[license-url]: https://github.com/NuvioMedia/NuvioWeb/blob/main/LICENSE
