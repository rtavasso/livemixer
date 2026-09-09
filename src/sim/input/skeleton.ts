/**
 * A tracked hand skeleton in a source frame, and the solid it stands for.
 *
 * Two sources know the skeleton: the Leap service's JSON API (`leap.ts`) and
 * the depth bridge running `--source leap` (`protocol.ts`), which projects the
 * LeapC skeleton into the same normalized box as its depth scan. Both reduce
 * their wire format to this one shape so the capsule rules live in one place:
 * positions in the source frame (open, NOT clamped, so a forearm leaving the
 * box keeps its direction) and widths as DIAMETERS along the source x axis.
 */
import type { Vec3 } from '../core/types';
import type { Capsule } from './types';

export interface SkeletonFinger {
  /** From the wrist outward: carpal (metacarpal base), knuckle, two inter-phalangeal joints, tip. */
  joints: [Vec3, Vec3, Vec3, Vec3, Vec3];
  /** Finger diameter, source-x units. */
  width: number;
  extended: boolean;
}

export interface Skeleton {
  palm: Vec3;
  wrist: Vec3;
  /** Where the forearm ends; sources trim it to a stub near the wrist before it gets here. */
  elbow?: Vec3;
  palmWidth?: number;
  armWidth?: number;
  /** Thumb → pinky; five when complete, fewer only if the source lost a finger's joints. */
  fingers: SkeletonFinger[];
}

/**
 * Width factor per bone from the wrist outward: the metacarpal is thicker than the finger
 * it carries (five of them make the palm), and the phalanges taper toward the tip.
 */
export const BONE_WIDTH_FACTORS = [1.15, 1, .9, .8] as const;
/** Forearm width factor over the reported arm width: the stub sits at the wrist, the arm's narrowest part. */
export const FOREARM_WIDTH_FACTOR = .85;
/** Anatomical stand-ins when a source omits a width: arm ≈ 0.68 × palm ≈ 3.2 × index finger (typical Leap reports). */
const ARM_FROM_PALM = .68, ARM_FROM_FINGER = 3.2;
/** Bones shorter than this (source units) are skipped: the Leap reports the thumb metacarpal as zero length. */
const MIN_BONE = 1e-6;

/**
 * Build the solid hand: up to four capsules per finger (three phalanges and the metacarpal
 * from the carpal base to the knuckle) and a forearm capsule from the wrist toward the elbow.
 * Radii are half the width times the bone's factor. Order: fingers as given, forearm last.
 */
export function skeletonCapsules(s: Skeleton): Capsule[] {
  const out: Capsule[] = [];
  const seg = (a: Vec3, b: Vec3, width: number) => {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    if (dx * dx + dy * dy + dz * dz < MIN_BONE * MIN_BONE) return;
    out.push({ a: { x: a.x, y: a.y, z: a.z }, b: { x: b.x, y: b.y, z: b.z }, radius: width / 2 });
  };
  for (const f of s.fingers) for (let i = 0; i < 4; i++) seg(f.joints[i], f.joints[i + 1], f.width * BONE_WIDTH_FACTORS[i]);
  if (s.elbow) {
    const finger = s.fingers[1] ?? s.fingers[0];
    const arm = s.armWidth ?? (s.palmWidth !== undefined ? s.palmWidth * ARM_FROM_PALM : finger ? finger.width * ARM_FROM_FINGER : undefined);
    if (arm !== undefined) seg(s.wrist, s.elbow, arm * FOREARM_WIDTH_FACTOR);
  }
  return out;
}

/** The point set a skeleton stands for: the palm, then the fingertips in finger order. */
export function skeletonPoints(s: Skeleton): Vec3[] {
  return [s.palm, ...s.fingers.map(f => f.joints[4])];
}
