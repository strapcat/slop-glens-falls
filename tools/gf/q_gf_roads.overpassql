[out:json][timeout:180];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street)(_link)?$"](43.290,-73.680,43.330,-73.610);
);
out body;
>;
out skel;
