const normalizeName = name => String(name || '').trim().toLowerCase();
// Verified on the public person page when API image data is absent.
// Source: https://comicvine.gamespot.com/mariko-tamaki/4040-60206/
const VERIFIED_PERSON_PHOTOS = {
  'mariko tamaki': {
    cv_person_id: '60206',
    image_url: 'https://comicvine.gamespot.com/a/uploads/scale_small/6/62444/1431885-tamaki_headshot.gif',
  },
};
function verifiedPersonPhoto(name) { return VERIFIED_PERSON_PHOTOS[normalizeName(name)] || null; }

function usableImage(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const file = url.split(/[?#]/)[0].split('/').pop();
  return /^(?:\d+-)?(?:blank|img_broken|image_not_available)\.(?:png|jpe?g|gif|webp)$/i.test(file) ? null : url;
}
function personImage(image) {
  return ['medium_url', 'small_url', 'super_url', 'original_url', 'thumb_url']
    .map(key => usableImage(image?.[key])).find(Boolean) || null;
}
function selectPerson(people, name) {
  const key = normalizeName(name).replace(/[^a-z0-9]/g, '');
  return people.filter(p => normalizeName(p.name).replace(/[^a-z0-9]/g, '') === key)
    .sort((a,b) => (b.count_of_issue_appearances || 0) - (a.count_of_issue_appearances || 0))[0];
}
function createPersonPhotos({ read, write, request, getKey, now = Date.now }) {
  const pending = new Map(), retryAfter = new Map();
  async function resolve(name) {
    const key = normalizeName(name);
    if (!key) return { image_url: null, cv_person_id: null };
    if (pending.has(key)) return pending.get(key);
    const cached = read(key);
    const verified = verifiedPersonPhoto(key);
    if (verified && !usableImage(cached?.image_url)) {
      write(key, verified);
      return { ...verified };
    }
    const clean = { image_url: usableImage(cached?.image_url), cv_person_id: cached?.cv_person_id || null };
    const stamp = cached?.cached_at ? Date.parse(cached.cached_at.replace(' ', 'T') + 'Z') : 0;
    const ttl = (clean.image_url ? 30 : 7) * 86400000;
    // Old placeholder URLs bypass the TTL once; a genuine no-photo result is stored as null.
    if (cached && (!cached.image_url || clean.image_url) && now() - stamp < ttl) return clean;
    if (!getKey() || (retryAfter.get(key) || 0) > now()) return clean;
    const task = (async () => {
      const get = async (url, params) => {
        const response = await request(url, { params: { api_key: getKey(), format: 'json', ...params }, timeout: 10000 });
        if (response.data?.status_code !== 1) throw new Error('Comic Vine person lookup was unsuccessful');
        return response.data.results;
      };
      let personId = clean.cv_person_id, imageUrl = null;
      if (!personId) {
        const people = await get('https://comicvine.gamespot.com/api/search', { query: name, resources: 'person', limit: 10, field_list: 'id,name,image,count_of_issue_appearances' });
        const person = selectPerson(Array.isArray(people) ? people : [], name);
        personId = person?.id ? String(person.id) : null;
        imageUrl = personImage(person?.image);
      }
      if (!imageUrl && personId && /^\d+$/.test(String(personId))) {
        const person = await get(`https://comicvine.gamespot.com/api/person/4040-${personId}/`, { field_list: 'id,name,image' });
        imageUrl = personImage(person?.image);
      }
      const result = { image_url: imageUrl, cv_person_id: personId };
      write(key, result);
      retryAfter.delete(key);
      return result;
    })();
    pending.set(key, task);
    try { return await task; }
    catch (error) { retryAfter.set(key, now() + 5 * 60000); throw error; }
    finally { pending.delete(key); }
  }
  return { resolve };
}
module.exports = { verifiedPersonPhoto, usableImage, personImage, selectPerson, createPersonPhotos };
