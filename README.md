# Spicetify Add to Queue After

This extension adds a context menu option that lets you insert tracks, albums, or playlists into your queue after a specific position, rather than just adding them to the end.

If you've ever wanted to queue something but have it play right after a particular track, this extension is for you.

## Features

- Right-click on any track, album, playlist, or multiple tracks to get the "Add to Queue After..." option
- Select a position from your current queue where you want the items inserted
- Works with tracks, albums, playlists, and local files
- Shows track names in the submenu so you can see exactly where items will be inserted

## Installation

- Open the [Spicetify Marketplace](https://github.com/spicetify/marketplace/wiki/Installation).
- Search for "Add to Queue After" (You might have to click on "Load more" first)
- Install & reload

## Development

Requires Spicetify CLI and pnpm.

```bash
pnpm install
pnpm build   # or: pnpm watch
spicetify extensions add-to-queue-after.js
spicetify apply -n
```

This project is built with [Spicetify Creator](https://github.com/spicetify/spicetify-creator)

## Notes

- The context menu option only appears when you have a queue with at least one track
- If you select to add after the last track in the queue, items will be added to the end normally

## License

[GNU General Public License v3.0](./LICENSE)
