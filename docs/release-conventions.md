# Release naming and version conventions

GitHub release titles and Git tags use exactly `v<SemVer>`: `v1.19.0`, for example.
Use lowercase `v`, all three numeric components, and no product prefix, spaces,
summary suffix, or leading zeroes. Put feature summaries in the release body.
Prerelease titles also match their tags exactly, for example `v1.20.0-rc.1`,
and the GitHub release must be marked as a prerelease.

Package and manifest versions use the same version without `v`, such as `1.19.0`.
`release-metadata.json` is the development version source; keep package, lockfile,
connector and plugin manifests, updater, and installer versions aligned using the
existing release checks. npm dist-tags such as `latest` are channels, not versions.
Choose major, minor, and patch increments according to Semantic Versioning:
breaking changes, compatible additions, and compatible fixes, respectively.

README keeps its machine-readable `### Latest release: 1.19.0` heading without `v`.
Client install pins track the verified published npm version, which can lag development.
Changelog headings retain the existing `## [1.19.0] - YYYY-MM-DD` format.
Do not rename historical tags, republish package versions, or change release assets
to fix a display title.

## Creating a release

After checking the matching commit, version metadata, and authorized release scope,
create the release with the same tag and title. For example:

```sh
gh release create v1.19.0 --verify-tag --title v1.19.0 --notes-file /path/to/release-notes.md
```

For a prerelease, include `--prerelease`. Follow `AGENTS.md` for validation and
publication evidence. This naming convention does not authorize a new publication.

## Auditing and repairing titles

```sh
GH_REPO=leancoderkavy/premiere-pro-mcp node scripts/normalize-release-names.mjs
GH_REPO=leancoderkavy/premiere-pro-mcp node scripts/normalize-release-names.mjs --check
GH_REPO=leancoderkavy/premiere-pro-mcp node scripts/normalize-release-names.mjs --apply
```

The default command previews changes. `--check` fails on drift. `--apply` updates
only display names and reads each changed title and tag back from GitHub. Bodies,
tags, assets, publication dates, and prerelease flags are preserved. Invalid tag
identities stop the operation before any updates.

The `Normalize release names` workflow repairs titles on release publication or
editing for tags containing the workflow; a manual dispatch audits and repairs the
full history, including older tags. It uses the naming script from the default
branch. Releases created with a workflow's `GITHUB_TOKEN`
do not trigger another workflow; those workflows must set the canonical title
themselves or explicitly run the naming script (see [GitHub's trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)). Existing attachment workflows
continue to verify exact tags against the release's version metadata.
