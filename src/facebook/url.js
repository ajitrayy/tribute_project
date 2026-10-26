// Parses the Page URL formats people copy out of a browser or the Facebook app
// into an identifier the Graph API accepts (a username/vanity name or a numeric id).

const FB_HOSTS = new Set([
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com',
  'mbasic.facebook.com', 'business.facebook.com', 'fb.com', 'www.fb.com',
]);

const NOT_A_PAGE = new Set([
  'groups', 'events', 'watch', 'marketplace', 'gaming', 'hashtag', 'login', 'login.php',
  'home.php', 'story.php', 'permalink.php', 'photo', 'photo.php', 'photos', 'reel', 'reels',
  'stories', 'search', 'help', 'privacy', 'policies', 'settings', 'messages', 'notifications',
]);

export class PageUrlError extends Error {}

export function parsePageUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new PageUrlError('Enter a Facebook Page URL.');

  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new PageUrlError('That is not a valid URL.');
  }
  const host = u.hostname.toLowerCase();
  if (!FB_HOSTS.has(host)) throw new PageUrlError('Only facebook.com Page URLs are supported.');

  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts[0] === 'profile.php') {
    const id = u.searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) throw new PageUrlError('profile.php URL is missing a numeric id.');
    return normalized(id);
  }
  if (parts[0] === 'share') {
    throw new PageUrlError(
      'Share links (facebook.com/share/...) hide the Page address. Open the link, then copy the Page URL from the address bar.',
    );
  }
  if (!parts.length) throw new PageUrlError('The URL does not include a Page name.');
  if (NOT_A_PAGE.has(parts[0].toLowerCase())) {
    throw new PageUrlError(`"${parts[0]}" URLs are not Pages. Use the Page's own URL, e.g. facebook.com/PageName.`);
  }

  // facebook.com/people/Some-Name/100089000000000/ and facebook.com/pages/Some-Name/12345
  if (parts[0] === 'people' || parts[0] === 'pages') {
    const id = parts.find((p) => /^\d{5,}$/.test(p));
    if (!id) throw new PageUrlError('Could not find the numeric Page id in that URL.');
    return normalized(id);
  }
  // facebook.com/pg/PageName/posts (legacy)
  const slug = parts[0] === 'pg' ? parts[1] : parts[0];
  if (!slug) throw new PageUrlError('The URL does not include a Page name.');

  // Vanity names: letters, digits and dots; numeric ids are also allowed. A
  // trailing "-<id>" (old style "Name-123456789") resolves to the id.
  const legacy = slug.match(/-(\d{8,})$/);
  if (legacy) return normalized(legacy[1]);
  if (!/^[A-Za-z0-9.]+$/.test(slug)) throw new PageUrlError(`"${slug}" is not a valid Page username.`);
  return normalized(slug);
}

function normalized(identifier) {
  return {
    identifier,
    canonicalUrl: /^\d+$/.test(identifier)
      ? `https://www.facebook.com/profile.php?id=${identifier}`
      : `https://www.facebook.com/${identifier}`,
  };
}
