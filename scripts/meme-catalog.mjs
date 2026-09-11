import { createHash } from 'node:crypto'

const commons = 'https://upload.wikimedia.org/wikipedia/commons'
const wiki = 'https://commons.wikimedia.org/wiki/File:'

function asset(id, title, url, hash, author, license, name) {
  return {
    id,
    title,
    url,
    hash,
    algorithm: hash.length === 40 ? 'sha1' : 'sha256',
    author,
    license,
    name,
    page: `${wiki}${encodeURIComponent(title.replaceAll(' ', '_'))}`
  }
}

export const imageAssets = [
  asset('honest-work', 'Farmer meme with apostrophe.jpg', `${commons}/a/ac/Farmer_meme_with_apostrophe.jpg`, '43bd7b43eb39c762a54d3cbaf60fb8ab2342013d99080eac0edeb926f6867ec2', 'Cakelot1', 'Public domain', 'Honest Work'),
  asset('joever', 'Joever meme.jpg', `${commons}/1/12/Joever_meme.jpg`, '40d31a7f3fd77a1b68f3f1701214513af20a2e97c3f5454c1e2e2a0d65170d0b', 'LBJ Library', 'Public domain', 'Joever'),
  asset('awesome-face', 'Awesome Face.svg', `${commons}/f/f3/Awesome_Face.svg`, 'c397ba3f432bf192946b148fa509c7fbdd2952155a57f26b93942720515103b3', 'East718, Holly Cheng, and Giro720', 'CC BY-SA 3.0', 'Awesome Face'),
  asset('monkey-selfie', 'Macaca nigra self-portrait large.jpg', `${commons}/4/4e/Macaca_nigra_self-portrait_large.jpg`, 'f9cf98fcf42cc144a2f4dd31a67a45e02022148a7bb3362b18e40f221ccada68', 'The pictured macaque', 'Public domain', 'Monkey Selfie'),
  asset('obama-still', 'Barack Obama Mic Drop 2016.jpg', `${commons}/0/04/Barack_Obama_Mic_Drop_2016.jpg`, 'cbadbf7585cf39ec776208712204fee65c3be474b7c87efa700690923e05b2f0', 'The White House', 'Public domain', 'Obama Mic Drop'),
  asset('lolcat', 'CatLolCatExample.jpg', `${commons}/4/44/CatLolCatExample.jpg`, 'add8cce020bc68b97fc873cc7993c9ddcae7ef6cee837404958aeaa661a5e7b7', 'Paulo Ordoveza', 'CC BY 2.0', 'Lolcat'),
  asset('backrooms', 'HobbyTown USA Oshkosh interior under construction 2002 (The Backrooms).jpg', `${commons}/b/bb/HobbyTown_USA_Oshkosh_interior_under_construction_2002_%28The_Backrooms%29.jpg`, '3e765051ee1f2862551758df6d75471f331e2c13', 'Bill Magritz or Bob Mazza', 'Copyrighted free use', 'Backrooms'),
  asset('illuminati', 'Illuminati triangle eye.png', `${commons}/a/a9/Illuminati_triangle_eye.png`, 'd300dcc81c42cbf60d58813c5f511d468c1b218b', 'United States Government', 'Public domain', 'Illuminati'),
  asset('ohio-farmer', 'Ohio farmer David Brandt.jpg', `${commons}/0/01/Ohio_farmer_David_Brandt.jpg`, '05dd3613a47fd8def9f8a90d85c591aa1acdfbee', 'Dianne Johnson, United States Department of Agriculture', 'Public domain', 'Ohio Farmer'),
  asset('iceberg', 'Wikipedia iceberg template.png', `${commons}/b/bf/Wikipedia_iceberg_template.png`, 'db24400e55089795c88575338856b71b4d387f7e', 'Uwe Kils, Wiska Bodo, Nohat, Gutza, Centrx, Stevertigo, Lane Hartwell, and others', 'CC BY-SA 4.0', 'Iceberg'),
  asset('keep-calm', 'Keep Calm and Carry On Poster.svg', `${commons}/3/30/Keep_Calm_and_Carry_On_Poster.svg`, '5eae56e0c9dd93db648235b8260af5246817e898', 'United Kingdom Government; vector by Mononomic', 'Public domain', 'Keep Calm'),
  asset('we-can-do-it', 'We Can Do It!.jpg', `${commons}/1/12/We_Can_Do_It%21.jpg`, '1fd0a9811fe881e13eaf7caa8d0983d26379b63c', 'J. Howard Miller', 'Public domain', 'We Can Do It'),
  asset('uncle-sam', 'J. M. Flagg, I Want You for U.S. Army poster (1917).jpg', `${commons}/5/59/J._M._Flagg%2C_I_Want_You_for_U.S._Army_poster_%281917%29.jpg`, '18c1a52a90ebc58d3cdf60684bb7923a01a54123', 'James Montgomery Flagg', 'Public domain', 'Uncle Sam'),
  asset('neck-guy', 'Charles Dion McDowell mugshot.jpg', `${commons}/d/d8/Charles_Dion_McDowell_mugshot.jpg`, 'a103cc31c2618ac76857f6e7a0051bf16440531e', "Escambia County Sheriff's Office", 'Public domain', 'Neck Guy'),
  asset('directed-by', 'Directed by Robert B. Weide.jpg', `${commons}/b/bb/Directed_by_Robert_B._Weide.jpg`, 'e26ed2949f486ea0d3dd3bf6aa117606c2fbe6a1', 'Robert B. Weide', 'Public domain', 'Directed By Robert Weide'),
  asset('rage-face', 'Rage face.png', `${commons}/b/b3/Rage_face.png`, '8185c682e11031b2504937e35fefce5db048568b', 'Smurfy', 'Public domain', 'Rage Face'),
  asset('live-reaction', 'Live Reaction meme template.png', `${commons}/6/60/Live_Reaction_meme_template.png`, 'ccb4b2a2a911b3b795640e5d98d5bdbfe81977a9', 'Unknown author', 'Public domain', 'Live Reaction'),
  asset('to-be-continued', 'To-Be-Continued Text Logo (à suivre).png', `${commons}/8/88/To-Be-Continued_Text_Logo_%28%C3%A0_suivre%29.png`, '4d1fc459eaa5c4931a099cf6fe4cfaa11b7f60da', 'LCCRAFT', 'CC BY-SA 4.0', 'To Be Continued'),
  asset('touch-grass', 'Touch Grass.jpg', `${commons}/9/9f/Touch_Grass.jpg`, 'cf0feb15c165fd08a5dee6b75fd714d8363fbe96', 'MiracleMiles', 'CC BY 4.0', 'Touch Grass'),
  asset('stonks', 'Stonks emoji.svg', `${commons}/2/24/Stonks_emoji.svg`, 'ee50210610701487cf97e1473bc4365ca6ebc5a7', 'Di (they-them)', 'CC BY-SA 4.0', 'Stonks')
]

export const animatedAssets = [
  asset('obama-gif', 'Barack Obama drops the mic.gif', `${commons}/1/15/Barack_Obama_drops_the_mic.gif`, 'f3f9cd9e7bc73518808ee5167695f42e7bef104098489137159e57620b62ef40', 'Jdlrobson', 'CC BY-SA 4.0', 'Obama Mic Drop'),
  asset('beautiful', 'NASA’s Guide to Visiting a Gamma-Ray Burst (SVS14355 - ItsBeautiful Reaction).gif', `${commons}/a/a0/NASA%E2%80%99s_Guide_to_Visiting_a_Gamma-Ray_Burst_%28SVS14355_-_ItsBeautiful_Reaction%29.gif`, '3cbbd2ca40049b8ad757d2f9d5034da93116491cb4c0a603b142fcaea908fde9', 'NASA Scientific Visualization Studio', 'Public domain', "It's Beautiful"),
  asset('nasa-dance', 'NASA Gangnam Style dance.gif', `${commons}/2/26/NASA_Gangnam_Style_dance.gif`, 'af5b9fa8a26a9ba7b0ea8e1ac331dbdb5fdbef8b', 'NASA Johnson', 'Public domain', 'NASA Dance'),
  asset('moon-salute', 'Youtubeastronautsonmoonot3.gif', `${commons}/e/eb/Youtubeastronautsonmoonot3.gif`, '18f113f46f59868408c2e1dc403a4364cf5135ba', 'Charles M. Duke, Jr.', 'Public domain', 'Moon Salute'),
  asset('zero-gravity', 'Kc-135.gif', `${commons}/0/03/Kc-135.gif`, '645ee1838859db8c219076c8ae52d2f7f0911458', 'NASA', 'Public domain', 'Zero Gravity'),
  asset('space-soda', 'STS-51-F astronaut drinking Pepsi in space (85HC289).gif', `${commons}/e/e9/STS-51-F_astronaut_drinking_Pepsi_in_space_%2885HC289%29.gif`, '7dc268cd24d378e564ca261ddfa86dd39deccfb8', 'NASA', 'Public domain', 'Space Soda'),
  asset('short-burst', 'NASA’s Guide to Visiting a Gamma-Ray Burst (SVS14355 - ShortGRB).gif', `${commons}/f/fd/NASA%E2%80%99s_Guide_to_Visiting_a_Gamma-Ray_Burst_%28SVS14355_-_ShortGRB%29.gif`, '85c22e60fa9beb11bd95b6c36506bf84ff24dd3f', 'NASA Scientific Visualization Studio', 'Public domain', 'That Was Quick'),
  asset('satellites', 'NASA’s Guide to Visiting a Gamma-Ray Burst (SVS14355 - GammaRaySatellites).gif', `${commons}/c/c2/NASA%E2%80%99s_Guide_to_Visiting_a_Gamma-Ray_Burst_%28SVS14355_-_GammaRaySatellites%29.gif`, '230c3b18a027a4a3e4bf02bf38282cef367c540f', 'NASA Scientific Visualization Studio', 'Public domain', 'Satellites Watching'),
  asset('math-meme', 'NASA’s Guide to Visiting a Gamma-Ray Burst (SVS14355 - MathMeme).gif', `${commons}/a/ab/NASA%E2%80%99s_Guide_to_Visiting_a_Gamma-Ray_Burst_%28SVS14355_-_MathMeme%29.gif`, '6d426530663f26e1887b198922524279b09b3645', 'NASA Scientific Visualization Studio', 'Public domain', 'Math'),
  asset('long-burst', 'NASA’s Guide to Visiting a Gamma-Ray Burst (SVS14355 - LongGRB).gif', `${commons}/4/45/NASA%E2%80%99s_Guide_to_Visiting_a_Gamma-Ray_Burst_%28SVS14355_-_LongGRB%29.gif`, '0f7150a96759ec1717d53e8b3f7b7e0a0d14240a', 'NASA Scientific Visualization Studio', 'Public domain', 'Long Story'),
  asset('million-years', 'NASA’s Guide to Visiting a Gamma-Ray Burst (SVS14355 - ItsBeenMillionYears).gif', `${commons}/b/ba/NASA%E2%80%99s_Guide_to_Visiting_a_Gamma-Ray_Burst_%28SVS14355_-_ItsBeenMillionYears%29.gif`, 'bd7b54d90c09778032899359cac82ca54bae6197', 'NASA Scientific Visualization Studio', 'Public domain', 'It Has Been Years'),
  asset('earth-shield', 'NASA’s Guide to Visiting a Gamma-Ray Burst (SVS14355 - EarthAtmosphere GammaRayProtection).gif', `${commons}/9/90/NASA%E2%80%99s_Guide_to_Visiting_a_Gamma-Ray_Burst_%28SVS14355_-_EarthAtmosphere_GammaRayProtection%29.gif`, '60eb3774975484a234793dd4a3841559e0c714f2', 'NASA Scientific Visualization Studio', 'Public domain', 'Earth Shield'),
  asset('air-quotes', 'Airquotes.gif', `${commons}/d/dd/Airquotes.gif`, '55ff74c3598cf5801bcb8eb55ab9003298720707', 'Dronthego', 'CC BY-SA 4.0', 'Air Quotes'),
  asset('nodding', 'Nodding gesture.gif', `${commons}/a/a2/Nodding_gesture.gif`, 'f48ca54c9b9cfd3f935b4364cd99b5c410cee560', 'Derfel73 and johnny automatic', 'Public domain', 'Nodding'),
  asset('bunny-hop', 'Bunny-hopping 2021-02-21.gif', `${commons}/4/4d/Bunny-hopping_2021-02-21.gif`, '322f330a500f0aacf65cdbad583c51a708b546c6', 'Asanagi', 'CC0 1.0', 'Bunny Hop'),
  asset('cake-walk', 'Cake walk 1903, 10 seconds.gif', `${commons}/4/4a/Cake_walk_1903%2C_10_seconds.gif`, 'e5f0260129b168eecc2f87880ee5fa6215bd3201', 'American Mutoscope and Biograph Company', 'Public domain', 'Cake Walk'),
  asset('excited-cat', '20170407一只因木天蓼兴奋的猫.gif', `${commons}/9/99/20170407%E4%B8%80%E5%8F%AA%E5%9B%A0%E6%9C%A8%E5%A4%A9%E8%93%BC%E5%85%B4%E5%A5%8B%E7%9A%84%E7%8C%AB.gif`, '866334fdfb86c0e0162154f08df456c309ac7bd9', 'MasaneMiyaPA', 'CC BY-SA 4.0', 'Excited Cat'),
  asset('cat-jumpscare', 'Cat Jumpscare.webm', `${commons}/0/07/Cat_Jumpscare.webm`, '19d717cf2ddc201522e762631a65eb11bd26ea5d', 'Panini!', 'CC0 1.0', 'Cat Jumpscare'),
  asset('dvd-corner', 'Freakout after DVD Player Screensaver Bubble Hits Corner Perfectly.webm', `${commons}/8/8f/Freakout_after_DVD_Player_Screensaver_Bubble_Hits_Corner_Perfectly.webm`, 'ef28c8044fe555a51ad7afa75d5647b77bba02f6', 'Josiah Wood', 'CC BY 3.0', 'DVD Corner Reaction'),
  asset('scary-maze-prank', 'Scary maze game prank edited 0.webm', `${commons}/a/a8/Scary_maze_game_prank_edited_0.webm`, '626e10a84894cdf7af429d61b5e09ed258d6075c', 'Benmite', 'CC BY-SA 4.0', 'Scary Maze Prank'),
  asset('scary-maze-reaction', 'Scary Maze Game Reaction edited 0.webm', `${commons}/8/80/Scary_Maze_Game_Reaction_edited_0.webm`, '80c0bec7723e8137dfee6265825a10d4f638d860', 'Benmite', 'CC BY-SA 4.0', 'Scary Maze Reaction'),
  asset('eyeroll', 'Eyeroll.webm', `${commons}/b/b6/Eyeroll.webm`, '57c5a0810ad60eca3a44ab6090f64695cafede2037a718fecd6c133dc2ca9aa5', 'Best Beta4lyfe', 'CC0 1.0', 'Eye Roll')
]

export const audioAssets = [
  asset('wilhelm', 'Wilhelm Scream.ogg', `${commons}/d/d9/Wilhelm_Scream.ogg`, '360097c9715f55abcc26ab73f12f69b730c660fbf019fc63caa685bfa9b6585b', 'Sheb Wooley; uploaded by Ben Burtt', 'CC0 1.0', 'Wilhelm Scream'),
  asset('sad-trombone', 'Sad Trombone-Joe Lamb-665429450.ogg', `${commons}/3/35/Sad_Trombone-Joe_Lamb-665429450.ogg`, '77de89cf35a24a8c205495d410b547781cd7018d9a60c9dcc1cfb72330775225', 'Joe Lamb', 'CC BY 3.0', 'Sad Trombone'),
  asset('explosion', 'Explosion 10.ogg', `${commons}/3/37/Explosion_10.ogg`, 'e24332ca6f3caf39bb5acb30ea91a722b9001163', 'BlastwaveFx.com', 'Public domain', 'Explosion'),
  asset('applause', 'Applause ii.ogg', `${commons}/0/09/Applause_ii.ogg`, 'bbb0d85e4cb1fa6bcb7d0245f1aedfc160cee0ed', 'Sandyrb', 'Public domain', 'Applause'),
  asset('crickets', 'Acheta-domesticus-Stridulation.ogg', `${commons}/2/2a/Acheta-domesticus-Stridulation.ogg`, '20f141a4593407d55d173953fc5625d8021eb75a', 'Maksim', 'CC BY 3.0', 'Crickets'),
  asset('rimshot', 'Rimshot loop 168bpm.ogg', `${commons}/2/2d/Rimshot_loop_168bpm.ogg`, '229e113ed40a8c1f49765f678c8b04f90e25f327', 'Pannage', 'CC BY-SA 4.0', 'Rimshot'),
  asset('boing', 'Deep twang of loose bow string.ogg', `${commons}/c/cd/Deep_twang_of_loose_bow_string.ogg`, 'a2d7da4040ba07bd5c6c58f32dc393965a4b5031', 'stephan', 'Public domain', 'Boing'),
  asset('laugh', '72842 lonemonk approx-800-laugh-1.wav', `${commons}/1/15/72842_lonemonk_approx-800-laugh-1.wav`, 'da2e56fef6eb5ce96a91b13fb3a6ab0160d0eaa7', 'lonemonk', 'CC BY 3.0', 'Laugh'),
  asset('laughter', '72844 lonemonk approx-800-laughter-and-clapter-1.wav', `${commons}/e/e5/72844_lonemonk_approx-800-laughter-and-clapter-1.wav`, 'b91dff872db3dc2c24caa7d23fa370c6ae2ec6bf', 'lonemonk', 'CC BY 3.0', 'Laughter'),
  asset('machine-gun-tap', 'Caneta Bate Mesa - Metralhadora - Dado.ogg', `${commons}/d/d2/Caneta_Bate_Mesa_-_Metralhadora_-_Dado.ogg`, '48873964ac22866cbb1dc47af58dcd216c2477ba', 'Rafael Tavares Juliani', 'CC0 1.0', 'Machine Gun Tap'),
  asset('echo-hit', 'Echo Bong.wav', `${commons}/c/c7/Echo_Bong.wav`, 'b81dc1de2183168abb4d61427c9b065ffa36fe30', 'Shawn Eary', 'CC0 1.0', 'Echo Hit'),
  asset('metal-bat', 'Fake Metal Bat.wav', `${commons}/4/4c/Fake_Metal_Bat.wav`, '4e8d6b3f250b4a5d01040ef088a3841a1e58a187', 'Shawn Eary', 'CC0 1.0', 'Metal Bat'),
  asset('fuu', 'Fuu som.ogg', `${commons}/9/98/Fuu_som.ogg`, '5e3c8226efa41d9baa7c34f6f6587f860b4ec3d0', 'Rafaeljuliani', 'CC0 1.0', 'Fuu'),
  asset('bleep', 'Kba-bleep1.wav', `${commons}/0/05/Kba-bleep1.wav`, '18ec4a176e9279f06842737863465f40d57bcffa', 'IOII IOIO IIOI', 'CC0 1.0', 'Bleep'),
  asset('lightning', 'Lighting sound film.wav', `${commons}/0/02/Lighting_sound_film.wav`, '7497861acbdfa343be20e26fb47a8bf616631bd9', 'Knites', 'CC0 1.0', 'Lightning'),
  asset('attention', 'Mini Acerto - Atenção.ogg', `${commons}/f/f4/Mini_Acerto_-_Aten%C3%A7%C3%A3o.ogg`, 'c438a2b22d58d723cd7136badaeed11a2d40970e', 'Rafael Tavares Juliani', 'CC0 1.0', 'Attention'),
  asset('finale', 'Mini Crescente Finale.ogg', `${commons}/1/14/Mini_Crescente_Finale.ogg`, '4eb5cccf152c50abe02c5c0395094f1043a7b8c1', 'Rafael Tavares Juliani', 'CC0 1.0', 'Finale'),
  asset('rewind', 'Retrocedendo.ogg', `${commons}/5/51/Retrocedendo.ogg`, 'ba0479a21ed9a934837d6c06aafb8828d02d1b14', 'Rafael Tavares Juliani', 'CC0 1.0', 'Rewind'),
  asset('spring-jump', 'Slide Pulo Mola.ogg', `${commons}/b/b8/Slide_Pulo_Mola.ogg`, '5c6edfbdefd0866efb6866ff58b0f9102f7078ef', 'Rafaeljuliani', 'CC0 1.0', 'Spring Jump'),
  asset('cartoon-laugh', 'Cartoon Laugh.ogg', `${commons}/c/cb/Cartoon_Laugh.ogg`, 'cea2e46a98020b391ad2499163d355bd67e698f2', 'JohnsonBrandEditing', 'CC0 1.0', 'Cartoon Laugh'),
  asset('cute-doop', 'Cute doop.ogg', `${commons}/b/b3/Cute_doop.ogg`, '9c3be106b92ce50aec089bac106188531dcf3bc9', 'stephan', 'Public domain', 'Cute Doop'),
  asset('dragon-bite', 'Dragon bite.ogg', `${commons}/7/7c/Dragon_bite.ogg`, '47a23b1b44a0a667b0da196d73303c7c96d1a499', 'gregoryweir', 'Public domain', 'Dragon Bite'),
  asset('pain-grunt', 'Grunt of pain.ogg', `${commons}/b/ba/Grunt_of_pain.ogg`, '0c41f8b8453f0fd6e49651e56db09729565573ea', 'gregoryweir', 'Public domain', 'Pain Grunt'),
  asset('gulp', 'Swallowing gulp.ogg', `${commons}/d/d5/Swallowing_gulp.ogg`, 'b314d5205ca260705b63e50dbcacac07904ae156', 'gregoryweir', 'Public domain', 'Gulp'),
  asset('weird-laughs', 'Weird cartoonish laughs.ogg', `${commons}/4/4d/Weird_cartoonish_laughs.ogg`, '7cd9c9d7fdaabe30807377eac3236fac2f787c06', 'stilgar', 'Public domain', 'Weird Laughs')
]

export const catalogVersion = 5
export const catalogFingerprint = createHash('sha256')
  .update(JSON.stringify([...imageAssets, ...animatedAssets, ...audioAssets].map(({ id, hash, name }) => ({ id, hash, name }))))
  .digest('hex')
