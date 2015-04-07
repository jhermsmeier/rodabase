var CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

var _         = require('underscore'),
    d64       = require('d64')(CHARS),
    bytewise  = require('bytewise');

var util = module.exports;

util.encode = function (source, trim){
  return d64.encode(bytewise.encode(source));
};
util.decode = function (source, trim){
  return bytewise.decode(d64.decode(source));
};
util.pad = function(str, count){
  return String(str + (new Array(count)).join('-')).slice(0, count);
};
util.trim = function(str){
  return String(str).replace(/-*$/,'');
};
util.clockObject = function(str){
  return _.object(
    str.split(',').map(function(rev){
      return [rev.slice(0,8), rev.slice(8)];
    })
  );
};

util.semaphore = require('./semaphore');
util.queue = require('./queue');