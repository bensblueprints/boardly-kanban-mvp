// Keep existing bookmarked project links opening the application.
if (location.hash.startsWith('#/')) {
  location.replace('/app' + location.search + location.hash);
}
