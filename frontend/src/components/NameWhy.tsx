/** «Γιατί αυτό το όνομα»: why a track shows the name it shows. Mounted in the inspector's «Στοιχεία αρχείου»
 *  (ProfileEditor); the why lane fills it in. `onChanged` tells the host that a correction, an undo or an
 *  «Εντάξει» changed the track's shown name, so it can load the track again. */
export function NameWhy(_props: { trackId: number; onChanged?: () => void }) {
  return null;
}
