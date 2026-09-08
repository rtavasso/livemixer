import { z } from 'zod';
const descriptor = z.object({
  version: z.literal(1), label: z.string().min(1),
  files: z.array(z.object({ name: z.string().regex(/^[^/\\]+\.wav$/i), path: z.string(), lastModified: z.number().finite().nonnegative() })).min(3).max(4000),
  project: z.string(),
});
export function preparedCollection(search: string): string | undefined {
  const id = new URLSearchParams(search).get('collection');
  if (id === null) return;
  if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(id)) throw new Error('Invalid local collection ID.');
  return '/scenes/' + id + '/';
}
export async function fetchPreparedLibrary(base: URL, progress: (message: string) => void) {
  const read = async (path: string) => {
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('Prepared library paths must stay inside the local collection.');
    const response = await fetch(url);
    if (!response.ok) throw new Error(path + ': HTTP ' + response.status);
    return response;
  };
  const config = descriptor.parse(await (await read('library.json')).json());
  const project: unknown = await (await read(config.project)).json(), files: File[] = [];
  for (const [i, entry] of config.files.entries()) {
    progress('Loading full song stems ' + (i + 1) + '/' + config.files.length + ' - ' + config.label);
    files.push(new File([await (await read(entry.path)).blob()], entry.name, { type: 'audio/wav', lastModified: entry.lastModified }));
  }
  return { files, project };
}
