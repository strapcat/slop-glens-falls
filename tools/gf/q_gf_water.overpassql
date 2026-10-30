[out:json][timeout:180];
(
  way["natural"="water"](43.290,-73.680,43.330,-73.610);
  relation["natural"="water"](43.290,-73.680,43.330,-73.610);
  way["waterway"~"^(riverbank|river|canal)$"](43.290,-73.680,43.330,-73.610);
  relation["waterway"~"^(riverbank|river|canal)$"](43.290,-73.680,43.330,-73.610);
);
out body;
>;
out skel;
