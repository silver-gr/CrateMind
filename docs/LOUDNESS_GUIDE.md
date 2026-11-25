# Loudness in a set: Auto Gain, the limiter and the Maximizer

A reference for deciding what to switch on when you play or record. It explains what each tool does to the sound,
with the numbers CrateMind actually uses, and when a Maximizer is worth it.

## The short version

| Tool | What it does | Does it change the sound? | Use it |
|---|---|---|---|
| **Auto Gain** | One volume setting per track, so all tracks play equally loud | No. Only louder or quieter | Always |
| **«Audio Limiter»** | Catches the rare peak that would overshoot | Not while it is idle, which is most of the time | Always, as a safety net |
| **Maximizer («MAX»)** | Pushes peaks down moment to moment so the whole mix can be louder | Yes: less punch, denser sound | Only in the cases listed below |

For a normal set of professionally mastered tracks: Auto Gain on, limiter on, Maximizer off.

Auto Gain and the limiter are both **off until you switch them on**: the «Ένταση ακρόασης» button at the bottom of the
window opens them, and shows the gain Auto Gain gave the current track.

## A few terms

- **dB (decibel):** the unit for level differences. +6 dB is roughly "twice the signal", +10 dB sounds roughly
  twice as loud, and 1 dB is about the smallest change most people notice.
- **Full scale (0 dBFS):** the highest level a digital file can hold. Levels are written as negative numbers below
  it: −1 dBFS is just under the top.
- **Peak:** the highest instant in the sound, usually the hit of the kick. It lasts a few thousandths of a second.
- **Clipping:** what happens when a peak tries to go above full scale. The top of the wave is cut flat, which
  sounds like crackle or harsh distortion.
- **LUFS:** a measure of how loud a track sounds *on average* to a listener, over the whole track. Less negative is
  louder: −8 LUFS is a loud club master, −14 LUFS is what streaming services aim at, −18 LUFS is quiet.
  The Library's «LUFS» column shows this number for each track.
- **Dynamic range:** the distance between a track's average level and its peaks. A track at −8 LUFS with peaks at
  −0.3 dBFS has about 8 dB of it. A lot of range feels punchy and open; very little feels dense and flat.
- **Headroom:** the empty space left between your loudest peak and full scale. It is what lets two tracks overlap
  without clipping.
- **Gain:** a plain volume change. It moves the whole track up or down and nothing else.
- **Limiter:** a tool that turns the level down for an instant when a peak would pass a set **ceiling**, then lets
  it back up.
- **Maximizer:** a limiter used on purpose and continuously: it pushes the peaks down, then raises everything, so
  the average gets louder.
- **Mastering:** the last step a producer or a studio does on a finished track: tone, width and exactly this kind
  of limiting, done once and checked by ear.

## Auto Gain

Auto Gain measures each track once (its LUFS and its highest peak) and applies **one gain value for the whole
track**. The track is not processed in any other way: it is the same as you setting the trim knob once, correctly.

What CrateMind does:

- It aims at **−18 LUFS** for every track.
- It never raises a track so far that its peak would pass **−1 dBFS**.
- It never turns down a track that is already at or below −18 LUFS.
- The change stays between −24 dB and +12 dB.
- A reading that cannot be real is not trusted: a peak above +6 dBFS (a damaged spot in the file) is ignored, and a
  track that measures louder than 0 LUFS gets no Auto Gain at all («Auto Gain: μη διαθέσιμο για αυτό το track»).

Examples:

| Track | Measured | Auto Gain | Result |
|---|---|---|---|
| A loud psytrance master | −8 LUFS, peak −0.3 | −10 dB | −18 LUFS |
| A modern downtempo track | −13 LUFS, peak −1.0 | −5 dB | −18 LUFS |
| A quiet, peaky track (old rip, demo) | −22 LUFS, peak −0.3 | wants +4 dB, but its peak leaves no room: 0 dB | stays about 4 dB quieter than the rest |

Two things follow from this:

- **Everything gets quieter when you switch Auto Gain on.** That is intended. Most masters are far louder than
  −18 LUFS, so they are turned down. Turn your speakers or amplifier up instead. The space this leaves is the
  headroom that lets two tracks play over each other in a transition, with an EQ boost, without clipping.
- **A quiet track with high peaks cannot be raised by gain alone.** That is the third row. Its peaks are already
  at the top, so any more gain would clip. This is the one situation where a tool that tames peaks is needed.

## «Audio Limiter»

The limiter watches each deck and steps in only when a peak would pass its ceiling of **−1 dB**. It looks 5 ms
ahead, so it can turn the level down smoothly just before the peak arrives.

- With Auto Gain on and mastered tracks, it does nothing almost all the time. You cannot hear an idle limiter.
- It starts to work when you push a deck: a big EQ boost, the trim turned up, or a quiet track raised by hand.
- When it works hard for a long stretch, you hear the same side effects as a Maximizer, because that is what it
  has become.

It protects each deck. When two decks play together, their sum can still be higher than either: two kicks that land
together add up to 6 dB. With Auto Gain on, about one blend in twelve would pass the top slightly; with Auto Gain off,
every blend would, by about 8 dB. For that there is a second, **always-on safety limiter on the master**, after both decks
and before the speakers and the recording. It has the same −1 dB ceiling, no switch, and does nothing until the sum
reaches it. While «MAX» is on, «MAX» does that job instead.

## Maximizer («MAX»)

The Maximizer sits on the master, after both decks. It turns the peaks down as they happen and raises the rest,
until the mix reaches a loudness you choose.

- **«Στόχος έντασης»** (−18 to −6 LUFS, default −9): how loud the result should be.
- **«Οροφή»** (−3 to 0 dB, default −1): the highest peak it lets through.
- The small bar next to «MAX» shows how much it is turning down right now. An empty bar means it is idle; a bar
  that moves on every kick means every kick is being reduced.

What you hear when it works:

- The kick loses some of its hit, because its peak is the first thing pushed down.
- Quiet details come up, so the mix feels denser and flatter.
- Pushed far, the level "pumps" in time with the kick, or distorts.

Three things to know:

- **It treats both decks at once.** It cannot fix one track and leave the other alone.
- **Louder always sounds better at first.** With Auto Gain on and the default settings, switching «MAX» on makes
  the output about 9 dB louder, and the ear reads that as "fuller". Compare fairly: turn your speakers down by the same amount, then
  listen to the kick.
- **It is part of personal builds only.** Public downloads of CrateMind do not contain it.

## Why a mastered track does not need it

A mastered track has already been through a limiter, on purpose. Take the psytrance master from the table: −8 LUFS
with peaks at −0.3. Someone decided that 8 dB between the body of the track and the kick's peak is the right
amount of punch for it.

To make that track 2 dB louder, there is nowhere to go: the peaks are already at the top. The only way is to take
2 dB more off every kick. The track gets louder and the kick gets softer, on a decision nobody listened to.

What a set needs from mastered tracks is that they are **equally loud**, not that they are louder. Gain does that
without touching the sound. This is why most DJs play with the mixing software alone, and why clubs ask you to
stay out of the red: the sound system has its own limiter after you.

## When a Maximizer earns its place

1. **A track that is quieter or rougher than the rest.** An unmastered demo, your own unfinished production, a
   vinyl or tape rip. It has high peaks and a low average, so Auto Gain cannot bring it up (the third row of the
   table). Find such tracks with `lufs:-14-` in the Library search, or by a low value in the «LUFS» column.
2. **Wide-dynamics music next to loud masters.** Downtempo and ambient often keep a lot of dynamic range. After a
   dense psytrance track they can feel thin even at the same LUFS.
3. **The finished recording of a set.** A recorded set is one long file that was never mastered as a whole. Bringing
   it to a consistent loudness afterwards is normal practice.
4. **Listening at low volume.** At night or on small speakers, less dynamic range makes quiet passages audible.
   This is a listening choice, not a mixing one.

For case 1, where one track needs help and the other does not, these are better than «MAX»:

- **Trim up, limiter on.** Raise that deck's trim until it matches the other deck by ear. The limiter catches the
  peaks of that deck only.
- **A plugin on that deck's slot** (experimental, macOS): the same idea with a tool of your choice.
- **Fix the file once.** If you play the track often, a properly mastered copy is the lasting answer.

## Recording a set

- **Record the clean mix.** Auto Gain on, limiter on, Maximizer off. The file then holds exactly what the tracks
  sounded like, with headroom.
- **Make it louder afterwards, if you want.** A whole-file pass through a maximizer (Ozone's, for example) can be
  adjusted, compared and redone. A choice made live cannot be undone.
- **«MAX» is recorded; VST3 plugins are not.** «REC» records the master after the built-in Maximizer. While the
  VST3 plugin slots are running, recording is refused, because the finished sound then exists only inside the
  plugin host.
- A clean recording at Auto Gain levels will look quiet in an editor, around −18 LUFS. That is fine: there is no
  quality loss in a 24-bit WAV, and it can be raised later by plain gain.

## Settings by situation

| Situation | Auto Gain | Limiter | «MAX» |
|---|---|---|---|
| A normal set of mastered tracks | on | on | off |
| One quiet or rough track in the set | on | on | off; raise that deck's trim |
| A whole set of quiet or unmastered material | on | on | on, «Στόχος έντασης» around −12 to −9, watch the bar |
| Recording a set | on | on | off; master the file afterwards |
| Quiet listening at home | on | on | on if you like it |

## Checking by ear and by eye

- **The «LUFS» column** tells you before you play which tracks are loud masters (about −6 to −10) and which are
  quiet (−14 and below).
- **The bar next to «MAX»** tells you how hard it works. A few moving pixels on the loudest hits is gentle. A bar
  that stays up is changing the sound all the time.
- **Listen to the kick** when you compare, at the same speaker loudness. If the kick sounds smaller or the mix
  breathes with it, the setting is too strong.
