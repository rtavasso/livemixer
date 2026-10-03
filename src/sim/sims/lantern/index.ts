/**
 * Lantern: one translucent jellyfish, glowing on black, that swims with the music.
 *
 * Its bell contracts once every `pulseBeats` beats of Live's transport (a free ~70 bpm breath
 * without music), and each contraction is the jet that moves it. It wanders the active area; a
 * still hand earns its trust (the shared `Mood`) and it settles just above it so its verlet
 * tentacles fall over the fingers (real collisions against the hand's capsules). A slow stroke
 * against the bell brightens it, a poke makes it flinch, and repeated fast motion sends it to a
 * far corner, dim, until calm returns. Its glow also rises with presence (the vocal gate).
 * A fist makes it wary (it holds back and draws its tentacles in), an open palm facing up invites
 * it lower onto the hand with a warmer glow, and a palm facing down keeps it hovering above.
 *
 * Physics and mind: creature.ts (plain TypeScript, unit-tested). Drawing: render.ts.
 * See docs/LIVING.md.
 */
import { defineSimulation } from '../../core/types';
import { areaUniform, LIVING_SIGNALS, pictureHands } from '../living';
import { DEFAULT_LANTERN, Lantern, MAX_TENTACLES } from './creature';
import { LanternRenderer } from './render';

export default defineSimulation({
  id: 'lantern',
  title: 'Lantern',
  description: 'One translucent jellyfish that pulses with the music, drifts to a still hand and drapes its tentacles over it.',
  hologramFrame: 'wall',
  params: {
    color: { kind: 'color', default: '#8b5cff', label: 'Rim colour', description: 'Colour of the bell\'s skin, margin and tentacles.' },
    core: { kind: 'color', default: '#ffae6b', label: 'Core colour', description: 'Colour of the light inside: gonads, core glow and oral arms.' },
    size: { kind: 'number', default: DEFAULT_LANTERN.size, min: .06, max: .22, step: .005, label: 'Bell size', description: 'Half-width of the bell, in canvas heights.' },
    tentacles: { kind: 'number', default: DEFAULT_LANTERN.tentacles, min: 6, max: MAX_TENTACLES, step: 1, label: 'Tentacles', description: 'Number of trailing tentacles (plus four oral arms).' },
    length: { kind: 'number', default: DEFAULT_LANTERN.length, min: .15, max: .7, step: .01, label: 'Tentacle length', description: 'Typical tentacle length, in canvas heights.' },
    pulseBeats: { kind: 'number', default: DEFAULT_LANTERN.pulseBeats, min: 1, max: 8, step: 1, unit: 'beats', label: 'Beats per pulse', description: 'One contraction (one jet) every this many beats of the music; fear halves it.' },
    glow: { kind: 'number', default: DEFAULT_LANTERN.glow, min: .2, max: 2, step: .05, label: 'Glow', description: 'Overall brightness.' },
    fistGap: { kind: 'number', default: DEFAULT_LANTERN.fistGap, min: 0, max: .25, step: .005, label: 'Fist distance', description: 'Extra height it keeps above a closed fist, in canvas heights.' },
    fistCurl: { kind: 'number', default: DEFAULT_LANTERN.fistCurl, min: 0, max: .8, step: .05, label: 'Fist curl', description: 'How far a closed fist makes it draw its tentacles in.' },
    palmSettle: { kind: 'number', default: DEFAULT_LANTERN.palmSettle, min: 0, max: .1, step: .005, label: 'Palm-up settle', description: 'How much lower it sits onto an open palm facing up (an invitation), in canvas heights.' },
    hoverGap: { kind: 'number', default: DEFAULT_LANTERN.hoverGap, min: 0, max: .3, step: .005, label: 'Palm-down hover', description: 'Extra height it hovers above a palm facing down, in canvas heights.' },
    gesture: { kind: 'number', default: DEFAULT_LANTERN.gesture, min: .1, max: 2, step: .05, unit: 's', label: 'Gesture easing', description: 'Seconds for the fist and palm responses to ease in, so tracker flicker never pops.' },
  },
  signals: LIVING_SIGNALS,
  create(ctx) {
    const creature = new Lantern(ctx.aspect);
    const renderer = new LanternRenderer(ctx);
    return {
      step(input, params) {
        creature.setFrame(ctx.aspect, areaUniform(ctx.activeArea));
        const { hands, primary } = pictureHands(input);
        creature.step({ dt: input.dt, hands, primary, presence: input.presence, music: input.music }, params);
      },
      render(frame, params) {
        renderer.render(creature, frame.width, frame.height, frame.aspect, frame.time, params);
      },
      signals() {
        return { presence: creature.presence, reach: creature.reach, lift: creature.lift, closeness: creature.closeness.value, agitation: creature.agitation.value };
      },
      dispose() { renderer.dispose(); },
    };
  },
});
