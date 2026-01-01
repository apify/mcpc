# Publishing Guide

## Reserve Package Name (Placeholder)

To reserve the `mcpc` package name on npm without publishing the full implementation:

1. Make sure you're logged in to npm:
   ```bash
   npm login
   ```

2. Run the placeholder publish script:
   ```bash
   npm run publish:placeholder
   ```

This will publish `mcpc@0.0.1` with a minimal placeholder that:
- Reserves the package name
- Points users to the GitHub repository
- Clearly indicates the package is under development

## Publish Full Version

When ready to publish the full implementation:

1. **Ensure everything is ready:**
   ```bash
   npm run build
   npm test
   npm run lint
   ```

2. **Update version** (choose appropriate level):
   ```bash
   npm version patch  # 0.0.1 -> 0.0.2
   npm version minor  # 0.0.x -> 0.1.0
   npm version major  # 0.x.x -> 1.0.0
   ```

3. **Publish:**
   ```bash
   npm publish --access public
   ```

   The `prepublishOnly` script will automatically:
   - Clean the dist folder
   - Run the build
   - Run all tests

4. **Push git tags:**
   ```bash
   git push --follow-tags
   ```

## What Gets Published

Files included in the npm package (see `.npmignore`):
- ✅ `dist/` - Compiled JavaScript
- ✅ `bin/` - CLI executables
- ✅ `package.json`
- ✅ `README.md`
- ✅ `LICENSE`

Files excluded:
- ❌ `src/` - TypeScript source (users only need compiled JS)
- ❌ `test/` - Test files
- ❌ `scripts/` - Development scripts
- ❌ Config files (tsconfig.json, etc.)

## Testing the Package Locally

Before publishing, test what will be included:

```bash
# See what files will be published
npm pack --dry-run

# Create a tarball to inspect
npm pack

# Test installation locally
npm install -g ./mcpc-0.1.0.tgz
mcpc --help
npm uninstall -g mcpc
```

## Version Strategy

- `0.0.x` - Placeholder / early development
- `0.1.0` - First functional release (direct connection working)
- `0.2.0` - Add session management / bridge process
- `0.3.0` - Add interactive shell
- `1.0.0` - Stable release with all core features

## Troubleshooting

### "You do not have permission to publish"
Make sure you're logged in: `npm whoami`

### "Package name too similar to existing package"
The name `mcpc` should be available, but if not, consider:
- `@apify/mcpc` (scoped package)
- `mcp-cli`
- `mcpcli`

### "prepublishOnly script failed"
Fix any build or test errors before publishing:
```bash
npm run build
npm test
```
