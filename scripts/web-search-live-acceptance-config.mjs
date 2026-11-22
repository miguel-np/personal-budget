const groups = [
  { host: 'boe.es', domain: 'boe.es', allowedDomains: ['boe.es'], query: 'site:boe.es texto consolidado Ley 39/2015 BOE' },
  { host: 'www.boe.es', domain: 'boe.es', allowedDomains: ['boe.es'], query: 'site:www.boe.es publicación oficial Ley 39/2015' },
  { host: 'sede.agenciatributaria.gob.es', domain: 'agenciatributaria.gob.es', allowedDomains: ['agenciatributaria.gob.es'], query: 'site:sede.agenciatributaria.gob.es manual IRPF información oficial' },
  { host: 'hacienda.gob.es', domain: 'hacienda.gob.es', allowedDomains: ['hacienda.gob.es'], query: 'site:hacienda.gob.es normativa tributaria publicaciones oficiales' },
  { host: 'www.hacienda.gob.es', domain: 'hacienda.gob.es', allowedDomains: ['hacienda.gob.es'], query: 'site:www.hacienda.gob.es información tributaria oficial' },
  { host: 'petete.tributos.hacienda.gob.es', domain: 'petete.tributos.hacienda.gob.es', allowedDomains: ['petete.tributos.hacienda.gob.es'], query: 'site:petete.tributos.hacienda.gob.es consultas vinculantes DGT IRPF' },
  { host: 'sede.tributos.hacienda.gob.es', domain: 'sede.tributos.hacienda.gob.es', allowedDomains: ['hacienda.gob.es'], query: 'site:sede.tributos.hacienda.gob.es consultas tributarias DGT' },
  { host: 'serviciostelematicosext.hacienda.gob.es', domain: 'serviciostelematicosext.hacienda.gob.es', allowedDomains: ['serviciostelematicosext.hacienda.gob.es'], query: 'site:serviciostelematicosext.hacienda.gob.es resoluciones TEAC' },
  { host: 'sede.tea.hacienda.gob.es', domain: 'sede.tea.hacienda.gob.es', allowedDomains: ['sede.tea.hacienda.gob.es'], query: 'site:sede.tea.hacienda.gob.es criterios y resoluciones TEAC' },
  { host: 'seg-social.es', domain: 'seg-social.es', allowedDomains: ['seg-social.es'], query: 'site:seg-social.es cotización Seguridad Social normativa' },
  { host: 'www.seg-social.es', domain: 'seg-social.es', allowedDomains: ['seg-social.es'], query: 'site:www.seg-social.es información oficial Seguridad Social' },
  { host: 'sede.seg-social.gob.es', domain: 'sede.seg-social.gob.es', allowedDomains: ['seg-social.gob.es'], query: 'site:sede.seg-social.gob.es sede electrónica Seguridad Social cotización' },
  { host: 'portal.seg-social.gob.es', domain: 'seg-social.gob.es', allowedDomains: ['seg-social.gob.es'], query: 'site:portal.seg-social.gob.es portal importass cotización' },
  { host: 'xunta.gal', domain: 'xunta.gal', allowedDomains: ['xunta.gal'], query: 'site:xunta.gal Diario Oficial de Galicia DOG normativa' },
  { host: 'www.xunta.gal', domain: 'xunta.gal', allowedDomains: ['xunta.gal'], query: 'site:www.xunta.gal Diario Oficial de Galicia publicación' },
  { host: 'sede.xunta.gal', domain: 'sede.xunta.gal', allowedDomains: ['xunta.gal'], query: 'site:sede.xunta.gal sede electrónica Xunta normativa' },
  { host: 'facenda.xunta.gal', domain: 'facenda.xunta.gal', allowedDomains: ['xunta.gal'], query: 'site:facenda.xunta.gal Facenda Galicia normativa tributaria' },
  { host: 'lex.gal', domain: 'lex.gal', allowedDomains: ['lex.gal'], query: 'site:lex.gal normativa gallega consolidada' },
  { host: 'www.lex.gal', domain: 'lex.gal', allowedDomains: ['lex.gal'], query: 'site:www.lex.gal legislación de Galicia texto consolidado' },
  { host: 'cnmv.es', domain: 'cnmv.es', allowedDomains: ['cnmv.es'], query: 'site:cnmv.es normativa CNMV inversores' },
  { host: 'www.cnmv.es', domain: 'cnmv.es', allowedDomains: ['cnmv.es'], query: 'site:www.cnmv.es información y normativa CNMV' },
  { host: 'bde.es', domain: 'bde.es', allowedDomains: ['bde.es'], query: 'site:bde.es normativa Banco de España' },
  { host: 'www.bde.es', domain: 'bde.es', allowedDomains: ['bde.es'], query: 'site:www.bde.es publicaciones Banco de España' },
  { host: 'sedeelectronica.bde.es', domain: 'bde.es', allowedDomains: ['bde.es'], query: 'site:sedeelectronica.bde.es sede electrónica Banco de España normativa' }
];
export const WEB_SEARCH_ACCEPTANCE_GROUPS = Object.freeze(
  groups.map((group) => Object.freeze({
    ...group,
    allowedDomains: Object.freeze([...group.allowedDomains]),
  })),
);
