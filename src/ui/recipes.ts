import { RECIPES, STEMS, type RecipeId, type Scene } from '../config';
const names = { other: 'Instruments', bass: 'Bass', drums: 'Drums', vocals: 'Vocals' };
export function describeRecipes(scene: Scene) {
  const groups: { id: RecipeId; ids: RecipeId[]; label: string; summary: string; signature: string }[] = [];
  for (const id of RECIPES) {
    const gains = scene.recipes[id], stems = STEMS.filter(stem => scene.stems[stem]);
    const signature = JSON.stringify(stems.map(stem => gains[stem]));
    const existing = groups.find(g => g.signature === signature);
    if (existing) { existing.ids.push(id); continue; }
    const active = stems.filter(stem => gains[stem] != null);
    const fullBed = ['other', 'bass', 'drums'].every(stem => active.includes(stem as typeof active[number]));
    const label = fullBed ? active.includes('vocals') ? 'With vocals' : 'Instrumental' : active.map(stem => names[stem]).join(' + ');
    const summary = stems.map(stem => `${names[stem]} ${gains[stem] == null ? 'off' : `${gains[stem]} dB`}`).join(' / ');
    groups.push({ id, ids: [id], label, summary, signature });
  }
  const labels = groups.map(g => g.label);
  groups.forEach((g, i) => { if (labels.filter(label => label === labels[i]).length > 1) g.label += ` ${labels.slice(0, i + 1).filter(label => label === labels[i]).length}`; });
  return groups;
}
