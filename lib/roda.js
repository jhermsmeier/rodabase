var ginga       = require('ginga'),
    params      = ginga.params,
    _           = require('underscore'),
    levelup     = require('levelup'),
    sublevel    = require('level-sublevel'),
    transaction = require('level-async-transaction'),
    mid         = require('./mid'),
    util        = require('./util'),
    range       = require('./range');

module.exports = function(path, options){
  //default options
  options = _.extend({}, options, {
    keyEncoding: 'utf8',
    valueEncoding: 'json'
  });

  var roda = {};

  //level-sublevel
  var db = sublevel(levelup(path, options));
  //level-async-transaction
  transaction(db);
  //unique id for db
  mid(db);

  function Roda(name){
    name = String(name);

    if(!(this instanceof Roda))
      return roda[name] || new Roda(name);

    if(roda[name] && this !== roda[name])
      throw new Error('Roda `'+name+'` has been initialised.');
    else
      roda[name] = this;

    // roda "/" prefixed
    this.store = db.sublevel('/'+name);
    //can retrieve global clock without scanning through rodas
    this._clock = db.sublevel('clock');

    this._name = name;
    this._changes = this.store.sublevel('changes');
    this._indices = this.store.sublevel('indices');
    this._indexed = this.store.sublevel('indexed');

    this._maps = null;
  }

  ginga(Roda);

  Roda.fn = Roda.prototype;
  Roda.db = db;
  Roda.transaction = db.transaction;
  Roda.util = util;
  Roda.id = db.mid;

  Roda.define('clock', function(ctx, done){
    var obj = {};
    db.sublevel('clock').createReadStream()
      .on('data', function(data){
        var name = data.key.slice(0, -8);
        obj[name] = obj[name] || [];
        obj[name].push(data.key.slice(-8) + data.value);
      })
      .on('close', function(){
        for(var name in obj)
          obj[name] = obj[name].join(',');
        done(null, obj);
      })
      .on('error', done);
  });


  var R = ginga(Roda.prototype);
  R.name = function(){
    return this._name;
  };
  R.queue = require('./queue');

  //Read
  R.define('get', params('id:string','index:string?','tx?'), function(ctx, done){
    function cb(err, val){
      //notFound should not return error but null value
      if(err && !err.notFound)
        done(err);
      else
        done(null, val || null);
    }
    var store = ctx.params.index ? 
      this._indices.sublevel(ctx.params.index) : this.store;
    if(ctx.params.tx){
      if(ctx.params.tx.db !== db)
        return next(new Error('Invalid transaction object.'));
      ctx.params.tx.get(util.encode(ctx.params.id), {
        prefix: store
      }, cb);
    }else{
      store.get(util.encode(ctx.params.id), cb);
    }
  });

  R.define('read', params(
    'index:string?','options:object?'
  ), function(ctx, next){
    var opts = ctx.options = 
      range( _.extend({}, ctx.params, ctx.params.options) );

    if(opts.index)
      ctx.stream = this._indices
        .sublevel(opts.index)
        .createValueStream(opts);
    else
      ctx.stream = this.store
        .createValueStream(opts);

    next();
  }, function(ctx, done){
    var result = [];
    ctx.stream
      .on('data', function(data){
        result.push(data);
      })
      .on('close', function(){
        done(null, result);
      })
      .on('error', done);
  });

  //Hooks
  function extend(ctx, next){
    _.extend(ctx, ctx.params);
    next();
  }

  R.define('validate', params(
    'result', 'transaction'
  ), extend, function(ctx, done){
    done(null, ctx.result);
  });

  R.define('diff', params(
    'current', 'result', 'transaction'
  ), extend, function(ctx, done){
    done(null, ctx.transaction);
  });

  //Write Operations

  function prepare(ctx, next, end){
    //prepare result
    ctx.result = _.clone(ctx.params.result || {});

    var deleted = (!ctx.params.result) && ('id' in ctx.params);

    if(deleted)
      ctx.result._deleted = true;
    else
      delete ctx.result._deleted;

    //init transaction
    if(ctx.params.tx){
      if(ctx.params.tx.db !== db)
        return next(new Error('Invalid transaction object.'));
      ctx.transaction = ctx.params.tx;
      //defer if within another transaction
      ctx.transaction.defer(function(cb){
        end(cb);
        next();
      });
    }else{
      ctx.transaction = db.transaction();
      next();
    }
  }

  function useMid(ctx, next){
    db.mid(function(err, mid){
      ctx.mid = mid;

      if('id' in ctx.params)
        ctx.result._id = ctx.params.id;
      else{
        //monotonic timestamp + mid
        ctx.result._id = util.encode64(util.timestamp()) + ctx.mid;
      }
      next();
    });
  }

  function validate(ctx, next){
    this.validate(
      ctx.result, 
      ctx.transaction,
      function(err, result){
        if(err) return next(err);

        ctx.result = result;
        next();
      }
    );
  }

  function current(ctx, next){
    var self = this;

    ctx.transaction.get(util.encode(ctx.result._id), {
      prefix: this.store 
    }, function(err, val){
      //return IO/other errors
      if(err && !err.notFound)
        return next(err);
      //dont proceed if delete non existing item
      if(!val && ctx.result._deleted)
        return next(null);
      if(val){
        ctx.current = val;
        //remove previous change
        ctx.transaction.del(ctx.current._rev, {
          prefix: self._changes 
        });
      }
      next();
    });
  }

  function rev(ctx, next){
    var self = this;

    var key = this._name + ctx.mid;
    ctx.transaction.get(key, {
      prefix: this._clock 
    }, function(err, val){
      //lamport timestamp
      var time = util.trim(util.encode64(
        Math.max(
          val ? util.decode64(
            util.pad(val, 12)
          ) : 0,
          ctx.current ? util.decode64(
            util.pad(ctx.current._rev.slice(8), 12)
          ) : 0
        ) + 1
      ));

      //generate rev id
      ctx.result._rev = ctx.mid + time;

      //lamport clock update
      ctx.transaction.put(key, time, {
        prefix: self._clock 
      });

      next();
    });
  }


  function diff(ctx, next){
    this.diff(
      ctx.current || null, 
      _.clone(ctx.result), //dont modify result
      ctx.transaction,
      function(err, res){
        if(err) return next(err);
        next();
      }
    );
  }

  function put(ctx, next){
    ctx.transaction
      .put(util.encode(ctx.result._id), ctx.result, {
        prefix: this.store 
      })
      .put(ctx.result._rev, ctx.result, {
        prefix: this._changes 
      });
    next();
  }

  function del(ctx, next){
    ctx.transaction
      .del(util.encode(ctx.result._id), {
        prefix: this.store 
      })
      .put(ctx.result._rev, ctx.result, {
        prefix: this._changes 
      });
    next();
  }

  function invoke(ctx, done){
    var result = _.clone(ctx.result);
    if(ctx.params.tx){
      //batched not yet committed
      done(null, result);
    }else{
      ctx.transaction.commit(function(err){
        if(err) done(err, null);
        else done(null, result);
      });
    }
  }

  R.define('put', params('id:string?','result:object','tx?'),
    prepare, useMid, validate, current, rev, diff, put, invoke);

  R.define('del', params('id:string','tx?'),
    prepare, useMid, current, rev, diff, del, invoke);

  //Index Mapper
  R.index = function(name, mapper){
    this._maps = this._maps || {};

    if(typeof name === 'string' && typeof mapper === 'function'){
      if(this._maps[name])
        throw new Error('Index mapper `'+name+'` must only assign once.');
      this._maps[name] = mapper;
    }else{
      throw new Error('Invalid index mapper');
    }
    return this;
  };

  //_rev validation
  R.use('diff', function(ctx, next){
    if(!ctx.current || ctx.result._rev > ctx.current._rev)
      return next();

    next(new Error('Revision _rev must be incremental.'));
  });

  //Index generation
  R.use('diff', function(ctx, next){
    if(!this._maps) return next();

    var self = this;
    var tx = ctx.transaction;

    tx.get(ctx.result._id, {
      prefix: this._indexed
    }, function(err, current){
      //delete current indices
      var name, i, l, keys, key;
      if(current){
        for(name in current){
          keys = current[name];
          for(i = 0, l = keys.length; i < l; i++){
            tx.del(keys[i], {
              prefix: self._indices.sublevel(name)
            });
          }
        }
      }

      //when delete
      if(!ctx.result){
        tx.put(ctx.result._id, {}, {
          prefix: self._indexed
        });
        return next();
      }

      var result = _.clone(ctx.result);
      var indexed = {};
      var async = false;

      var plan = 0;

      function emit(name, key, value, unique){
        if(async)
          throw new Error('Index mapper must not be async.');

        if(value === true){
          unique = true;
          value = null;
        }

        //append unique timestamp for non-unqiue key
        var enKey = util.encode(key) + (
          unique ? '' : util.encode(util.timestamp()) );

        //record encoded key
        indexed[name].push(enKey);

        //check unique
        if(unique === true)
          tx.defer(function(cb){
            tx.get(enKey, {
              prefix: self._indices.sublevel(name)
            }, function(err, val){
              if(val) cb(new Error(key + ' must be unique.'));
              else cb();
            });
          });

        //put index store
        tx.defer(function(cb){
          tx.put(enKey, _.extend(value || _.clone(result), {
            _id: ctx.result._id, _key: key
          }), {
            prefix: self._indices.sublevel(name)
          }, cb);
        });
      }

      for(name in self._maps){
        indexed[name] = [];
        self._maps[name](result, emit.bind(null, name));
      }
      //new indexed keys
      tx.put(ctx.result._id, indexed, {
        prefix: self._indexed
      });
      async = true;

      next();
    });
  });

  //Changes

  R.define('clock', function(ctx, done){
    var arr = [];
    this._clock.createReadStream({
      gt: this._name, lt: this._name + '~'
    })
      .on('data', function(data){
        arr.push(data.key.slice(-8) + data.value);
      })
      .on('close', function(){
        done(null, arr.join(','));
      })
      .on('error', done);
  });

  R.define('changes', params(
    'since:string?','limit:number?'
  ), function(ctx, done, end){
    var limit = ctx.params.limit;
    var count = 0;
    var result = [];
    var self = this;

    function receive(mid, start, cb){
      if(limit && count >= limit)
        return cb(null, result);
      var opts = {};
      if(limit)
        opts.limit = limit - count;
      if(mid){
        opts.gt = mid + (start || '');
        opts.lt = mid + '~';
      }
      self._changes.createValueStream(opts)
        .on('data', function(data){
          result.push(data);
          count++;
        })
        .on('close', function(){
          cb(null, result);
        })
        .on('error', cb);
    }

    if(!ctx.params.since){
      receive(null, null, done);
    }else{
      this.clock(function(err, data){
        var clock = util.clockObject(data);
        var since = util.clockObject(ctx.params.since);
        var q = util.queue();
        for(var mid in clock){
          if(!since[mid] || since[mid] < clock[mid])
            q.add(receive.bind(null, mid, since[mid]));
        }
        q.start(function(err){
          if(err) return done(err);
          done(null, result);
        });
      });
    }
  });

  return Roda;
};