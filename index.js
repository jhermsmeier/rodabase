var _           = require('underscore'),
    levelup     = require('levelup'),
    sublevel    = require('level-sublevel'),
    transaction = require('level-async-transaction'),
    mid         = require('./lib/mid'),
    Roda        = require('./lib/roda');

module.exports = function(path, options){
  //default options
  options = _.extend({
  }, options, {
    keyEncoding: 'utf8',
    valueEncoding: 'json'
  });

  var db, id,
      map = {};

  //level-sublevel
  db = sublevel( levelup(path, options) );
  //level-async-transaction
  db = transaction(db);

  if(!id){
    //generate mid
    id = mid(path);
  }

  function base(name){
    map[name] = map[name] || new Roda(base, name);
    return map[name];
  }
  base.db = db;
  base.transaction = db.transaction;
  base.all = Roda.prototype;

  base.id = function(){
    return id;
  };

  return base;
};
