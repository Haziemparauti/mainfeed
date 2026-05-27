-- Mainfeed D1 migration → v5 IMAGES (Flux + PuLID cosplay-image quota)
-- Run: wrangler d1 execute mainfeed-db --remote --file=worker/schema_v5_images.sql
--
-- Adds the image-format half of v5 (videos + GIFs were the first half).
-- See [[mainfeed_image_library_architecture]] for the full spec.
--
-- Architecture: images are generated FRESH per request via Flux.1-schnell +
-- PuLID-FLUX. NO stock library — variety comes from prompt-template + slot-
-- value space. Each template has 3-5 slots × ~5 values each ≈ 125 unique
-- prompts per template. 50 templates × 125 ≈ 6,250 unique images per user
-- (exhausts at 625 days of 10/day quota). Plenty.
--
-- Uniqueness key for the Layer A query (per [[mainfeed_uniqueness_guarantee]]):
--   (user_id, image_template_id, generation_prompt)  — the filled prompt
-- ensures the same template can yield distinct images for the same user as
-- long as the slot values differ.
--
-- Idempotent: column-adds wrapped to silently no-op on re-run.

-- generated_pieces: add image_template_id ----------------------------------------
-- NULL for video/GIF pieces; non-NULL for image pieces.
ALTER TABLE generated_pieces ADD COLUMN image_template_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pieces_user_image_template
  ON generated_pieces(user_id, image_template_id);

-- image_templates: 50 MVP cosplay templates --------------------------------------
CREATE TABLE IF NOT EXISTS image_templates (
  id              TEXT PRIMARY KEY,
  category        TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  slots           TEXT NOT NULL,           -- JSON: {"slot_name": ["v1","v2",...]}
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_templates_active_category
  ON image_templates(active, category);

-- 50-template seed ----------------------------------------------------------------
-- {bucket_phrase} is filled at queue time with the user's appearance bucket
-- (e.g. "man with medium-length dark straight hair, medium-brown skin").
-- The 40 bucket → phrase mapping lives in [[mainfeed_library_curation_plan]].
INSERT OR REPLACE INTO image_templates (id, category, prompt_template, slots, active, created_at) VALUES
  -- ====== Movie posters (6) ======
  ('movie_poster_action_hero_v1', 'movie_poster',
   'movie poster, action hero, {bucket_phrase}, holding {prop}, {lighting} lighting, cinematic, dramatic, intense expression, ultra detailed',
   '{"prop":["a pistol","a katana","a grenade","a sniper rifle","a combat knife"],"lighting":["neon","sunset","noir","explosion","rainy"]}',
   1, unixepoch()),
  ('movie_poster_horror_villain_v1', 'movie_poster',
   'horror movie poster, sinister villain, {bucket_phrase}, {prop}, {lighting} lighting, dark atmosphere, unsettling, ultra detailed',
   '{"prop":["wielding an axe","wearing a creepy mask","covered in dripping blood","with glowing eyes","emerging from shadows"],"lighting":["candlelit","blood-red","moonlit","strobing","fog-shrouded"]}',
   1, unixepoch()),
  ('movie_poster_romcom_lead_v1', 'movie_poster',
   'romantic comedy movie poster, romantic lead, {bucket_phrase}, {prop}, {lighting} lighting, warm, charming smile, cinematic',
   '{"prop":["holding flowers","under a Paris cafe awning","leaning on a vintage car","on a Brooklyn rooftop","under string lights"],"lighting":["golden hour","soft pastel","warm sunset","candlelit","spring morning"]}',
   1, unixepoch()),
  ('movie_poster_spy_thriller_v1', 'movie_poster',
   'spy thriller movie poster, undercover agent, {bucket_phrase}, wearing a {outfit}, {prop}, {lighting} lighting, sleek, dangerous',
   '{"outfit":["tailored black tuxedo","leather trench coat","white linen suit","matte gray combat outfit","designer evening gown"],"prop":["holding a silenced pistol","with a martini glass","in front of casino chandeliers","watching from a rooftop","exiting a sleek car"],"lighting":["neon Hong Kong","Monte Carlo gold","cold blue Berlin","rainy Tokyo","Venice lagoon dusk"]}',
   1, unixepoch()),
  ('movie_poster_crime_drama_v1', 'movie_poster',
   'gritty crime drama movie poster, antihero, {bucket_phrase}, {prop}, {lighting} lighting, urban decay, intense stare, film grain',
   '{"prop":["lighting a cigarette","counting hundred-dollar bills","leaning against a brick alley wall","holding a revolver","with a fedora pulled low"],"lighting":["dimly-lit bar","streetlamp orange","police strobe","subway flicker","warehouse fluorescent"]}',
   1, unixepoch()),
  ('movie_poster_indie_a24_v1', 'movie_poster',
   'A24 indie film poster, contemplative, {bucket_phrase}, {prop}, {lighting} lighting, melancholic, 35mm film aesthetic, soft focus',
   '{"prop":["staring out a rain-streaked window","sitting alone on a diner stool","walking through a sunflower field","on a quiet suburban porch","by a foggy lake"],"lighting":["overcast","summer haze","early morning","winter pale","fading dusk"]}',
   1, unixepoch()),

  -- ====== Music album covers (5) ======
  ('album_cover_hip_hop_v1', 'album_cover',
   'hip-hop album cover, {bucket_phrase}, {pose}, wearing {outfit}, {lighting} lighting, luxurious, confident, ultra detailed',
   '{"pose":["arms crossed","tossing cash","leaning on a Lamborghini","seated on a throne","walking out of a private jet"],"outfit":["a gold chain over a hoodie","a fur coat and Cuban links","designer streetwear","an all-white tracksuit","diamond-encrusted jewelry"],"lighting":["studio strobe","penthouse city view","Miami sunset","Vegas neon","helipad gold"]}',
   1, unixepoch()),
  ('album_cover_rock_v1', 'album_cover',
   'rock album cover, {bucket_phrase}, {pose}, wearing {outfit}, {lighting} lighting, edgy, rebellious, distressed texture',
   '{"pose":["screaming into a vintage mic","holding an electric guitar","mid-headbang on stage","silhouetted against stage smoke","leaning on an amp stack"],"outfit":["a leather jacket and band tee","ripped denim and chains","studded leather","a sleeveless flannel","torn black tank top"],"lighting":["red stage spotlight","strobing white flash","smoky purple haze","arena floodlight","backstage shadow"]}',
   1, unixepoch()),
  ('album_cover_pop_diva_v1', 'album_cover',
   'pop diva album cover, {bucket_phrase}, {pose}, wearing {outfit}, {lighting} lighting, glamorous, high fashion, polished',
   '{"pose":["mid-twirl on a runway","holding a microphone like a crown","with arms raised triumphantly","poised in a sequined dress","blowing a kiss to camera"],"outfit":["a sequined silver gown","a sparkling crystal corset","an avant-garde feathered cape","a glossy latex bodysuit","metallic pink couture"],"lighting":["pink neon","disco ball reflection","stadium pyrotechnics","high-fashion studio","rooftop sunset"]}',
   1, unixepoch()),
  ('album_cover_edm_festival_v1', 'album_cover',
   'EDM festival album cover, {bucket_phrase}, {pose}, wearing {outfit}, {lighting} lighting, electric, vibrant, kinetic',
   '{"pose":["hands raised behind decks","jumping with confetti exploding","silhouette against a massive LED wall","crowd-surfing","behind a fog-shrouded DJ booth"],"outfit":["a neon-rave outfit","reflective chrome streetwear","LED-strip jacket","cyber goggles and harness","festival face paint and beads"],"lighting":["laser show","rainbow lasers","UV blacklight","strobing electric blue","sunset main stage"]}',
   1, unixepoch()),
  ('album_cover_rnb_sultry_v1', 'album_cover',
   'R&B album cover, {bucket_phrase}, {pose}, wearing {outfit}, {lighting} lighting, sultry, intimate, soft focus',
   '{"pose":["lying on velvet drapery","reclining on a piano","sitting in a vintage bathtub","leaning against floor-to-ceiling windows","under candlelight in silk sheets"],"outfit":["silk pajamas","a satin slip dress","an open silk robe","a fur-trimmed coat","a tailored dark suit unbuttoned"],"lighting":["candlelit","rose-gold sunset","amber bedroom lamp","moonlight through blinds","fireplace glow"]}',
   1, unixepoch()),

  -- ====== Magazine covers (5) ======
  ('magazine_vogue_v1', 'magazine_cover',
   'Vogue-style high fashion magazine cover, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, editorial, ultra polished',
   '{"outfit":["an ivory haute couture gown","a structured Balenciaga blazer","a sequined evening dress","a minimalist black turtleneck","an architectural sculptural dress"],"pose":["confident over-the-shoulder gaze","laughing mid-stride","seated cross-legged","leaning against a marble pillar","walking through a sun-drenched colonnade"],"lighting":["softbox studio","Mediterranean noon","Paris atelier","backstage couture","golden Tuscan sunset"]}',
   1, unixepoch()),
  ('magazine_time_person_of_year_v1', 'magazine_cover',
   'Time Person of the Year magazine cover style, {bucket_phrase}, {pose}, wearing {outfit}, {lighting} lighting, serious, authoritative, ultra detailed',
   '{"pose":["arms crossed, direct gaze","standing in front of a world map","at a podium mid-speech","seated at a leather executive chair","walking briskly toward camera"],"outfit":["a sharp navy power suit","an academic robe","a tailored black turtleneck","a crisp white shirt and tie","a designer charcoal blazer"],"lighting":["dramatic side-lit","oval office gold","library bronze","press conference flash","window-lit chairman of the board"]}',
   1, unixepoch()),
  ('magazine_forbes_mogul_v1', 'magazine_cover',
   'Forbes magazine cover, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, billionaire mogul, polished, ultra detailed',
   '{"outfit":["a bespoke charcoal three-piece suit","a luxe cashmere sweater","a tailored midnight tuxedo","a crisp business shirt and silver tie","an old-money tweed jacket"],"pose":["with arms folded behind a mahogany desk","stepping out of a private jet","at the helm of a yacht","in a glass corner office","reviewing a stock chart"],"lighting":["penthouse window gold","yacht deck noon","corporate boardroom","private jet cabin","ascending elevator skyline"]}',
   1, unixepoch()),
  ('magazine_natgeo_explorer_v1', 'magazine_cover',
   'National Geographic explorer magazine cover, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, adventurous, weathered, ultra detailed',
   '{"outfit":["a worn khaki field vest","a desert-stained explorer outfit","arctic expedition gear","a jungle adventurer kit","a mountaineering coat"],"pose":["at the summit holding a compass","wading through a jungle river","inspecting ancient ruins","kneeling beside a leopard","photographing a remote tribe"],"lighting":["Sahara golden hour","Amazon dappled","Antarctic blue","Himalayan dawn","African savanna dusk"]}',
   1, unixepoch()),
  ('magazine_rolling_stone_v1', 'magazine_cover',
   'Rolling Stone magazine cover, {bucket_phrase}, {pose}, wearing {outfit}, {lighting} lighting, rockstar, iconic, gritty polish',
   '{"pose":["holding an electric guitar over the shoulder","laughing into the camera","leaning against a tour bus","sprawled on a hotel bed","in the spotlight on stage"],"outfit":["a fringed leather jacket","ripped jeans and a vintage band tee","a velvet blazer and bare chest","sparkling glam rock outfit","an all-black punk ensemble"],"lighting":["red stage flood","backstage tungsten","desert highway dusk","studio softbox","green room neon"]}',
   1, unixepoch()),

  -- ====== Fantasy / RPG (7) ======
  ('fantasy_medieval_knight_v1', 'fantasy',
   'epic fantasy art, medieval knight, {bucket_phrase}, wearing {armor}, holding {prop}, {lighting} lighting, heroic, ultra detailed',
   '{"armor":["polished steel plate armor","silver-trimmed black armor","ornate gold-inlaid armor","weathered chainmail and tabard","crimson dragon-emblem armor"],"prop":["a longsword","a battle axe","a kite shield emblazoned with a lion","a war hammer","a glowing enchanted blade"],"lighting":["misty battlefield dawn","castle hall torchlight","stormy sky","sunset before battle","cathedral stained-glass glow"]}',
   1, unixepoch()),
  ('fantasy_wizard_v1', 'fantasy',
   'epic fantasy wizard, {bucket_phrase}, wearing {robe}, holding {prop}, {lighting} lighting, mystical, arcane, ultra detailed',
   '{"robe":["a midnight-blue starry robe","an emerald druid cloak","a crimson archmage outfit","a tattered grey hermit cloak","an ornate gold-embroidered robe"],"prop":["a glowing staff","an ancient spellbook","a swirling orb of light","summoning lightning from fingertips","a crystal-tipped wand"],"lighting":["arcane library candles","mountain peak storm","enchanted forest glow","crystal cave shimmer","floating runes light"]}',
   1, unixepoch()),
  ('fantasy_pirate_captain_v1', 'fantasy',
   'pirate captain, {bucket_phrase}, wearing {outfit}, holding {prop}, {lighting} lighting, swashbuckling, weathered, ultra detailed',
   '{"outfit":["a tricorne hat and red captain coat","a tattered leather vest","ornate gold-trimmed naval coat","an open white shirt and sash","a black pirate ensemble"],"prop":["a cutlass","a flintlock pistol","a treasure chest overflowing with gold","a ship wheel","a parrot on the shoulder"],"lighting":["stormy sea night","Caribbean sunset","ship deck lantern","Tortuga tavern","tropical island noon"]}',
   1, unixepoch()),
  ('fantasy_viking_v1', 'fantasy',
   'Viking warrior, {bucket_phrase}, wearing {outfit}, holding {prop}, {lighting} lighting, fierce, snow-dusted, ultra detailed',
   '{"outfit":["fur and leather armor","a horned helmet and chainmail","Nordic warrior gear","a wolf-pelt cloak","intricate runic battle dress"],"prop":["a battle axe","a Viking shield","a horn of mead","a longsword overhead","fire-lit torch"],"lighting":["snowy fjord","longhouse firelight","Nordic aurora","fog-bound coast","torchlit raid night"]}',
   1, unixepoch()),
  ('fantasy_samurai_v1', 'fantasy',
   'feudal Japanese samurai, {bucket_phrase}, wearing {armor}, holding {prop}, {lighting} lighting, honorable, intense, ultra detailed',
   '{"armor":["traditional black-lacquer samurai armor","crimson o-yoroi armor","ceremonial gold-trimmed armor","weathered ronin garb","white-and-blue clan armor"],"prop":["a katana drawn","a tachi sword over the shoulder","a war fan","a yumi longbow","a folded kabuto helmet"],"lighting":["cherry blossom dawn","temple lantern","misty bamboo forest","battlefield sunset","torii gate sunrise"]}',
   1, unixepoch()),
  ('fantasy_vampire_lord_v1', 'fantasy',
   'gothic vampire lord, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, immortal, regal, ultra detailed',
   '{"outfit":["a black velvet aristocratic coat","a high-collared crimson cape","a silk Victorian outfit","an ornate gothic dress","a tailored modern noir suit"],"pose":["holding a goblet of wine","emerging from a coffin","seated on a gothic throne","wings spread silhouetted","raising fangs to camera"],"lighting":["moonlit castle balcony","blood-red chandelier","crypt candlelight","gothic cathedral","stormy gargoyle rooftop"]}',
   1, unixepoch()),
  ('fantasy_dragon_rider_v1', 'fantasy',
   'epic dragon rider, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, mythic, awe-inspiring, ultra detailed',
   '{"outfit":["scaled leather armor","an ornate dragonbone outfit","a flowing rider cape","a steel-and-silk warrior dress","a hooded mystic robe"],"pose":["standing in front of a massive dragon","mid-flight on a dragon back","commanding a dragon to roar","kneeling beside a dragon hatchling","silhouetted against a fire-breathing dragon"],"lighting":["volcanic glow","cloud-piercing sunrise","mountain peak storm","mythic dawn","aurora-lit night"]}',
   1, unixepoch()),

  -- ====== Sci-fi (4) ======
  ('scifi_astronaut_mars_v1', 'scifi',
   'NASA astronaut on Mars, {bucket_phrase}, wearing {suit}, {pose}, {lighting} lighting, photorealistic space mission, ultra detailed',
   '{"suit":["a white modern spacesuit","a sleek next-gen exploration suit","a battered scientific EVA suit","a red-trimmed expedition suit","a black SpaceX-style flight suit"],"pose":["planting a flag","examining a rock sample","walking toward a Mars rover","gazing at Earth in the sky","emerging from a habitat airlock"],"lighting":["Martian sunrise","red dust storm","crater shadow","sunset over Olympus Mons","blue-tinted twilight"]}',
   1, unixepoch()),
  ('scifi_cyberpunk_hacker_v1', 'scifi',
   'cyberpunk hacker, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, neo-Tokyo, neon-soaked, ultra detailed',
   '{"outfit":["a glowing cyber jacket","a tactical mesh outfit with LED trim","a hoodie with neural-link cables","a futuristic streetwear ensemble","a chrome-plated bodysuit"],"pose":["typing across a holographic interface","leaning against a graffitied alley","perched on a rain-soaked rooftop","staring into a multi-screen array","walking through neon market stalls"],"lighting":["pink-and-cyan neon","rainy alley","holographic billboards","rooftop megacity","underground server-room glow"]}',
   1, unixepoch()),
  ('scifi_mech_pilot_v1', 'scifi',
   'giant mech pilot, {bucket_phrase}, wearing {suit}, {pose}, {lighting} lighting, anime-inspired sci-fi, ultra detailed',
   '{"suit":["a sleek pilot suit with helmet under arm","a battered combat pilot uniform","a futuristic exo-suit","a colorful ace pilot outfit","an elite squadron flight suit"],"pose":["standing in front of a massive mech","climbing into a cockpit","arms crossed on a hangar deck","saluting before launch","silhouetted by mech eyes glowing"],"lighting":["hangar fluorescent","alien-planet sunset","reactor blue glow","mech cockpit interior","battlefield smoke"]}',
   1, unixepoch()),
  ('scifi_steampunk_inventor_v1', 'scifi',
   'steampunk inventor, {bucket_phrase}, wearing {outfit}, holding {prop}, {lighting} lighting, Victorian gears, ultra detailed',
   '{"outfit":["a brass-buttoned waistcoat with goggles","a leather aviator coat","a Victorian dress with mechanical corset","a top hat and embellished tailcoat","a workshop apron over a vest"],"prop":["a mechanical wrench","a glowing brass orb","a vintage ray-gun","a clockwork mask","blueprints unrolled"],"lighting":["workshop lamps","airship deck noon","London fog","copper-pipe boiler glow","sunset over zeppelins"]}',
   1, unixepoch()),

  -- ====== Professional cosplay (6) ======
  ('professional_f1_driver_v1', 'professional',
   'Formula 1 race driver, {bucket_phrase}, wearing {suit}, {pose}, {lighting} lighting, podium glory, ultra detailed',
   '{"suit":["a red Ferrari-style racing suit","a Mercedes-style silver racing suit","a McLaren orange racing suit","a Red Bull-style navy suit","a black Carbon-fiber suit"],"pose":["holding a racing helmet","walking the paddock","crouching beside a tire","stepping out of a cockpit","fist-pumping under finish-line lights"],"lighting":["Monaco sunset","Silverstone overcast","Singapore night race","Monza noon","Abu Dhabi dusk"]}',
   1, unixepoch()),
  ('professional_olympic_gold_v1', 'professional',
   'Olympic gold medalist, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, triumphant, stadium, ultra detailed',
   '{"outfit":["a national team tracksuit","a sleek competition swimsuit","a gymnastics leotard","a track and field uniform","a fencing whites uniform"],"pose":["biting a gold medal","arms raised on a podium","wrapped in a national flag","mid-celebration leap","saluting the stadium crowd"],"lighting":["stadium floodlight","podium spotlight","press-flash gold","national anthem dusk","arena LED wall"]}',
   1, unixepoch()),
  ('professional_michelin_chef_v1', 'professional',
   'Michelin-star chef, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, culinary mastery, ultra detailed',
   '{"outfit":["a crisp white chef coat and toque","a black tailored chef jacket","an apron over rolled sleeves","a Michelin-tier embroidered coat","a pristine Parisian kitchen uniform"],"pose":["plating a tasting-menu dish","tossing a sauté pan over flames","carving a roast","inspecting an open-flame grill","presenting a finished plate"],"lighting":["restaurant kitchen warmth","Paris bistro window","open-fire glow","tasting menu spotlight","cold-storage walk-in chill"]}',
   1, unixepoch()),
  ('professional_detective_noir_v1', 'professional',
   '1940s film noir detective, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, smoky shadows, black-and-white aesthetic, ultra detailed',
   '{"outfit":["a fedora and trench coat","a vintage three-piece suit","a tailored pinstripe suit","a rumpled overcoat with a loosened tie","a vintage detective uniform"],"pose":["lighting a cigarette","examining a clue under a desk lamp","leaning against an office doorway","walking down a rain-soaked street","at a typewriter desk"],"lighting":["venetian blinds shadow","streetlamp pool of light","cigarette ember glow","interrogation lamp","fog-shrouded alley"]}',
   1, unixepoch()),
  ('professional_brain_surgeon_v1', 'professional',
   'world-class brain surgeon, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, operating-theater intensity, ultra detailed',
   '{"outfit":["surgical scrubs and mask down","a sterile gown and loupes","navy scrubs and surgical cap","a long white coat over scrubs","operating-room blue garb"],"pose":["mid-operation with instruments","reviewing a brain scan","scrubbing in at a sink","explaining a procedure on an X-ray","staring intently through magnifier loupes"],"lighting":["operating theater overhead","cool blue surgical","hospital corridor","X-ray viewer glow","scrub-room fluorescent"]}',
   1, unixepoch()),
  ('professional_firefighter_v1', 'professional',
   'heroic firefighter, {bucket_phrase}, wearing {gear}, {pose}, {lighting} lighting, smoke and flames, ultra detailed',
   '{"gear":["full turnout gear and helmet","an oxygen mask pulled down","a soot-streaked uniform","a captain coat with reflective strips","a wildland-fire crew outfit"],"pose":["holding an axe over a collapsed beam","carrying a child to safety","spraying a hose at a blaze","emerging from smoke","saluting a fallen flag"],"lighting":["burning building orange","wildfire dusk","flashing red engine lights","backlit smoke","station-house tungsten"]}',
   1, unixepoch()),

  -- ====== Sports (4) ======
  ('sports_nba_dunk_v1', 'sports',
   'NBA-style basketball player, {bucket_phrase}, wearing {jersey}, {pose}, {lighting} lighting, slam-dunk drama, ultra detailed',
   '{"jersey":["a Lakers-yellow jersey","a Bulls-red jersey","a Celtics-green jersey","a Warriors-blue jersey","a Heat-black jersey"],"pose":["mid-dunk above the rim","celebrating a buzzer-beater","dribbling past a defender","posed with the trophy","tipping off at center court"],"lighting":["arena spotlight","finals confetti","tunnel-entry strobes","practice-court overhead","draft-night flash"]}',
   1, unixepoch()),
  ('sports_boxer_v1', 'sports',
   'world-champion boxer, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, gritty determination, ultra detailed',
   '{"outfit":["championship boxing shorts and gold belt","a sweat-soaked tank top and gloves","an embroidered fight robe","a hooded training kit","a corner-mans wrap and headgear"],"pose":["arms raised victorious in the ring","mid-punch on a heavy bag","staring down across a press scale","hooded walking out to a fight","corner stool between rounds"],"lighting":["arena spotlight","gym shadowy","Vegas marquee","corner cutman lamp","weigh-in flash"]}',
   1, unixepoch()),
  ('sports_f1_podium_champagne_v1', 'sports',
   'Formula 1 podium celebration, {bucket_phrase}, wearing {suit}, {pose}, {lighting} lighting, champagne spray, ultra detailed',
   '{"suit":["a red Ferrari-style racing suit","a Mercedes-style silver racing suit","a Red Bull-style navy suit","a McLaren orange racing suit","a black carbon-fiber suit"],"pose":["spraying champagne overhead","kissing the winners trophy","arms raised on the top step","national anthem hand-on-heart","helmet held high"],"lighting":["podium spotlight","Monaco sunset","Abu Dhabi dusk","race-day flash photography","champagne droplets in light"]}',
   1, unixepoch()),
  ('sports_olympic_gymnast_v1', 'sports',
   'Olympic gymnast, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, mid-routine grace, ultra detailed',
   '{"outfit":["a sequined competition leotard","a national-team unitard","an embroidered podium tracksuit","a chalk-dusted training kit","a gold-medal warm-up jacket"],"pose":["mid-air on a balance beam","sticking a vault landing","performing a floor-routine pose","on the uneven bars","arms raised after a perfect 10"],"lighting":["arena overhead","scoreboard glow","gym chalk-dust haze","national-anthem podium","tunnel walkout"]}',
   1, unixepoch()),

  -- ====== Aesthetic vibes (5) ======
  ('aesthetic_cottagecore_v1', 'aesthetic',
   'cottagecore aesthetic portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, pastoral, dreamy, ultra detailed',
   '{"outfit":["a flowing linen dress with a wildflower crown","a knitted cardigan and pinafore","a vintage cotton blouse and skirt","a hand-embroidered apron","a Victorian high-collar dress"],"pose":["gathering wildflowers in a basket","reading a book under a willow tree","baking pies at a farmhouse window","feeding ducks at a pond","wandering a sunflower field"],"lighting":["golden-hour meadow","misty cottage morning","summer haze","candlelit kitchen","late-afternoon orchard"]}',
   1, unixepoch()),
  ('aesthetic_dark_academia_v1', 'aesthetic',
   'dark academia aesthetic portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, ivy-covered scholarly mood, ultra detailed',
   '{"outfit":["a tweed blazer and turtleneck","a pleated skirt and Oxford shirt","an Ivy League sweater and tie","a long wool coat and scarf","a vintage academic robe"],"pose":["reading an ancient leather-bound book","writing notes by candlelight","walking a cobblestone university courtyard","seated at a vintage library desk","peering through a brass telescope"],"lighting":["old-library lamplight","autumn quad overcast","candlelit study","reading-room window","Gothic chapel dusk"]}',
   1, unixepoch()),
  ('aesthetic_y2k_nostalgia_v1', 'aesthetic',
   'Y2K nostalgia portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, early-2000s glossy, ultra detailed',
   '{"outfit":["a velour tracksuit and tinted sunglasses","a metallic mini-skirt and crop top","low-rise jeans and a baby tee","a juicy-style trucker hat outfit","platform sneakers and rhinestone tank"],"pose":["flip phone to ear at a mall","sitting on a bedazzled inflatable chair","dancing in a teen bedroom","posing in front of a Y2K poster wall","on rollerblades at a strip mall"],"lighting":["pink fluorescent","frosted-glass disco","mall-arcade glow","prom-night flash","early-internet web-cam"]}',
   1, unixepoch()),
  ('aesthetic_vaporwave_v1', 'aesthetic',
   'vaporwave synthwave portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, retro 80s neon dream, ultra detailed',
   '{"outfit":["an 80s neon windbreaker","a pastel synth-pop outfit","a chrome-trimmed retro-futurist jacket","gradient sunglasses and a wide collar","an 80s aerobics ensemble"],"pose":["leaning on a vintage 80s sports car","silhouetted against palm trees","by a glowing arcade machine","in front of a sunset highway","walking through a checkered-floor mall"],"lighting":["neon-pink and cyan","palm-tree sunset gradient","retro-arcade glow","grid-floor synth horizon","CRT-monitor blue"]}',
   1, unixepoch()),
  ('aesthetic_old_hollywood_v1', 'aesthetic',
   'old Hollywood glamour portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, 1940s black-and-white star, ultra detailed',
   '{"outfit":["a satin evening gown and pearls","a tailored tuxedo and bow tie","a fur stole and long gloves","a sequined cocktail dress","a Hollywood smoking jacket"],"pose":["holding a long cigarette holder","laughing on a red carpet","leaning against a vintage convertible","at a martini-and-piano bar","posed on a mahogany staircase"],"lighting":["studio key light","old-Hollywood spotlight","press-flash magnesium","art-deco lounge","red-carpet bulb-flash"]}',
   1, unixepoch()),

  -- ====== Holiday / seasonal (4) ======
  ('holiday_halloween_vampire_v1', 'holiday',
   'Halloween vampire costume portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, spooky-glam, ultra detailed',
   '{"outfit":["a high-collared black cape and red waistcoat","a gothic Victorian dress with lace","fangs and a velvet aristocrat coat","a blood-spattered formal outfit","an elegant modern vampire suit"],"pose":["fangs bared at camera","cape spread under a full moon","emerging from a mausoleum","stalking a foggy graveyard","raising a goblet of red wine"],"lighting":["full-moon blue","candlelit crypt","blood-red chandelier","stormy graveyard","gothic mansion window"]}',
   1, unixepoch()),
  ('holiday_halloween_zombie_v1', 'holiday',
   'Halloween zombie costume portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, undead horror, ultra detailed',
   '{"outfit":["tattered bloody clothes and pale makeup","a ripped wedding dress and decay makeup","a zombie business suit","a corpse cheerleader outfit","a post-apocalyptic survivor zombie kit"],"pose":["lurching toward camera","clawing out of a grave","mid-snarl with arms outstretched","wandering a foggy cemetery","silhouetted against a burning city"],"lighting":["moonlit graveyard","apocalyptic dusk","strobing horror light","backlit smoke","crimson sunset"]}',
   1, unixepoch()),
  ('holiday_christmas_santa_v1', 'holiday',
   'Christmas Santa portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, festive cheer, ultra detailed',
   '{"outfit":["a classic red Santa suit","a stylish modern Mrs. Claus outfit","a Nordic-style holiday sweater and Santa hat","a velvet red cape with white fur","a Santa workshop apron"],"pose":["holding a sack of presents","laughing by a roaring fireplace","decorating a tall Christmas tree","feeding reindeer in snow","peeking down a chimney"],"lighting":["fireplace warm","fairy-light tree","snowy night porch","candlelit gingerbread kitchen","aurora over a sleigh"]}',
   1, unixepoch()),
  ('holiday_dia_de_los_muertos_v1', 'holiday',
   'Dia de los Muertos calavera portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, vibrant skull-art, ultra detailed',
   '{"outfit":["intricate sugar-skull face paint and floral headdress","a black mantilla with embroidered roses","a colorful traditional dress with marigolds","a charro suit with calavera makeup","an elegant gown with skeletal embroidery"],"pose":["holding a marigold bouquet","beside a candle-lit ofrenda","dancing under papel picado banners","staring solemnly with sugar-skull paint","raising a clay mug among offerings"],"lighting":["candlelit altar","marigold-orange glow","plaza string-light evening","cathedral candles","sunset cemetery"]}',
   1, unixepoch()),

  -- ====== Internet / pop culture (4) ======
  ('internet_wanted_poster_v1', 'internet',
   'old Wild West wanted poster portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, sepia photograph, ultra detailed',
   '{"outfit":["a dusty cowboy hat and bandana","a sheriff vest and pocket watch","an outlaw long coat and gun belt","a frontier dress with shawl","a gambler suit and waistcoat"],"pose":["arms crossed, steely-eyed stare","hand resting on a holstered revolver","leaning against a saloon doorway","smoking a long cigar","seated at a card-table standoff"],"lighting":["saloon kerosene","desert dusk","sepia daguerreotype","jailhouse lantern","high-noon harsh sun"]}',
   1, unixepoch()),
  ('internet_comic_book_panel_v1', 'internet',
   'comic book panel portrait, superhero style, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, halftone dots, bold inked outlines, ultra detailed',
   '{"outfit":["a sleek superhero bodysuit with cape","an armored vigilante outfit","a cosmic-themed hero costume","a stealth ninja-style hero suit","a classic Silver Age hero costume"],"pose":["mid-leap from a rooftop","fist raised heroically","shielding civilians","silhouetted against a city skyline","standing atop a gargoyle"],"lighting":["city-night neon","explosion glow","comic-book sunset","alley street-lamp","rooftop moonlight"]}',
   1, unixepoch()),
  ('internet_pageant_winner_v1', 'internet',
   'beauty pageant winner portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, crown and sash glory, ultra detailed',
   '{"outfit":["a sparkling crystal evening gown","a national-costume dress","a satin sash and tiara","a vintage pageant gown","a modern haute-couture pageant dress"],"pose":["wearing a tiara, arm raised with bouquet","tearful first-place moment","walking the runway with sash","posed beside a winners trophy","blowing a kiss to the audience"],"lighting":["stage spotlight","press-flash bouquet","pageant runway glow","national-anthem podium","rhinestone-reflected sparkle"]}',
   1, unixepoch()),
  ('internet_yearbook_portrait_v1', 'internet',
   '80s high school yearbook portrait, {bucket_phrase}, wearing {outfit}, {pose}, {lighting} lighting, awkwardly earnest, ultra detailed',
   '{"outfit":["a denim jacket and band-tee","a pastel sweater over a collared shirt","a varsity letterman jacket","an oversized 80s blazer with bow-tie","a frilled prom dress"],"pose":["chin-on-hand classic pose","leaning against a fake bookshelf","seated by an artificial rainbow backdrop","laser-grid synth background portrait","arms crossed in front of a chalkboard"],"lighting":["softbox key-and-fill","laser-grid backdrop","fake-bookshelf studio","gradient blue studio","feathered hair backlight"]}',
   1, unixepoch());

-- Verification: should be 50 active templates after this migration ---------------
-- SELECT category, COUNT(*) FROM image_templates WHERE active = 1 GROUP BY category;
-- Expected: movie_poster=6, album_cover=5, magazine_cover=5, fantasy=7, scifi=4,
--           professional=6, sports=4, aesthetic=5, holiday=4, internet=4  (sum=50)
