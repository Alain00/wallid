# Artwork is a favicon first, an upload second

A claim shows an image. There are two ways to give us one, and the order they
are offered in is the decision.

## The favicon is the default path

A buyer arriving here has a URL and no design intent. Asking them for a square
PNG is asking them to open an image editor before they can spend a dollar, and
most of them will not. So the URL field resolves the artwork on blur: the Worker
fetches their page, reads whatever icon it declares, and the logo appears in the
cell before they are asked for a card.

`apple-touch-icon` is preferred over any declared `icon`, and both over
`/favicon.ico`. That order is not alphabetical: the touch icon is specified at
180px and is the only one a site is likely to have *drawn* rather than shrunk. A
cell here is drawn at up to 80px and upscaled on zoom, so the difference between
the 180px asset and the 16px one is the difference between a logo and a smudge.

The upload is what they reach for afterwards, when the favicon turns out to be a
blur. It is the second field, not the first.

## What this costs, and what is done about it

The Worker fetches a URL a stranger typed, from our side of the network. That is
a request forgery primitive rather than a broken link if it is left open, so
`normaliseUrl` is the gate every outbound URL on this wall goes through:

- https only, and no credentials in the authority. `https://paypal.com@evil.example`
  reads as a real link at exactly the glance a wall of logos gets.
- Literal private and loopback hosts refused. This is textual and therefore
  incomplete — a hostname whose DNS points at 127.0.0.1 passes it — and the
  remaining defence is that a Worker's `fetch` has no privileged network to
  reach into. Stated as a limitation rather than papered over.
- Size checked from the header before the body is read, so a stranger's server
  offering a 40MB "favicon" costs us a header.

No SVG, in either path. It is a document, it can carry script and external
references, and serving one from our own origin next to a payment flow is a
stored-XSS surface for the sake of a file format. No GIF either: animation turns
a wall of logos into a casino, and refusing the container is more honest than
accepting it and flattening to frame one.

## Keys are content hashes

An artwork's R2 key is the hash of its bytes. That gives three things at once:
the same logo stores once however many claims use it, the object can be served
`immutable` because the bytes under a key *are* the key, and removing a file that
turned out to be somebody else's trademark removes it from every claim using it.

Artwork is uploaded before payment, not after. An image whose claim is never paid
for is a few KB under a hash, which costs less than holding bytes in a session
across a redirect to Stripe and losing the buyer's upload while they look for
their card.

## The ground under the logo is derived, not chosen

A claim's background colour comes from a hash of its id. Nobody picks it.

This is the one thing kept from generative-avatar thinking, and it is what stops
the board degrading into the Million Dollar Homepage. Let every buyer choose a
background and the wall is beige, red, and flashing within a week, and the
zoomed-out view — the thing that makes this a wall rather than a list — stops
being worth looking at. Derived, dark, low-chroma: it is a mount for somebody's
logo, not a colour competing with it.

Artwork is drawn once across a claim's whole rectangle and then clipped to the
cells it still holds, which is what makes a partially-eaten claim draw with a
hole in the right place without the renderer knowing anything about takeovers.
