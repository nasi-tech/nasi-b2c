var express = require('express');
var router = express.Router();
var request = require('request');
var Client = require('ssh2').Client;
var conf = require('../conf/config.js');
var log4js = require('log4js');
var logger = log4js.getLogger();
logger.level = 'debug';

//==========Configuration====
var token = conf.token;
var cf_key = conf.cf_key;
var cf_email = conf.cf_email;
var cf_dns = conf.cf_dns;
var broof_ssh_host = conf.broof_ssh_host;
var broof_ssh_username = conf.broof_ssh_username;
var broof_ssh_password = conf.broof_ssh_password;
//==========================
var ip = "";
var password = "";

/* GET home page. */
router.get('/', function (req, res) {
  res.json({
    msg: "api"
  });
});

router.get('/ip', async function (req, res) {
  res.setHeader("Content-Type", "text/plain");
  res.send(ip + "\r\n");
});


function getClusterId() {
  return new Promise(function (resolve, reject) {
    request({
      method: 'GET',
      url: "https://api.daocloud.io/v1/clusters",
      headers: { "Authorization": token }
    },
      function (error, response, body) {
        if (error) {
          logger.error(error);
        } else {
          node_cluster_id = JSON.parse(body).clusters[0].node_cluster_id;
          logger.info("取得node_cluster_id");
          resolve(node_cluster_id);
        }
      });
  });
}

function getStreamId() {
  return new Promise(function (resolve, reject) {
    request({
      method: 'POST',
      url: "https://api.daocloud.io/v1/stream",
      headers: { "Authorization": token }
    },
      function (error, response, body) {
        if (error) {
          logger.error(error);
        } else {
          stream_room = JSON.parse(body).stream_room;
          logger.info("取得stream_Id");
          resolve(stream_room);
        }
      });
  });
}


function createNode() {
  return new Promise(async function (resolve, reject) {
    var jsonData = {
      "stream_room": await getStreamId(),
      "node_cluster_id": await getClusterId()
    }
    request({
      method: 'POST',
      url: "https://api.daocloud.io/v1/single_runtime/nodes",
      json: jsonData,
      headers: {
        "Authorization": token,
        "Content-Type": "application/json"
      }
    },
      function (error, response, body) {
        if (body.errno) {
          var flag = false;
          while (!flag) {
            request({
              method: 'POST',
              url: "https://api.daocloud.io/v1/single_runtime/nodes",
              json: jsonData,
              headers: {
                "Authorization": token,
                "Content-Type": "application/json"
              }
            }, function (error, response, body) {
              logger.info("再次建立Docker主机");
            });
          }
        } else {
          logger.info("建立Docker主机成功");
          resolve(body);
        }
      });
  });
}

//查询信息 并得到密码
router.get('/info', function (req, res) {
  request({
    method: 'GET',
    url: "https://api.daocloud.io/v1/single_runtime/nodes",
    headers: {
      "Authorization": token
    }
  }, async function (error, response, body) {
    var data = JSON.parse(body);
    if (data) {
      if (!data.nodes || data.nodes.length == 0) {
        logger.warn("Docker主机不存在，需要重新建立");
        await createNode();
      } else {
        ip = data.nodes[0].sandbox_ip_address;
        password = data.nodes[0].sandbox_password;
        logger.info("准备建立shadowsocks");
        await createShadowsocks(ip, password);
        await updateInfo();
        await updateDNS(ip);
        await restartBroof();
      }
      res.send("[Info] ssh ubuntu@" + ip + " ->" + password);
    } else {
      res.send("[Info] 服务器需要重新建立");
    }
  });
});

// async function info() {
//   var flag = false;
//   while (!flag) {
//     var info = await updateInfo();
//     console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Info] 循环取得信息");
//     if (info != -99) {
//       flag = true;
//     }
//   }
// }

function updateInfo() {
  return new Promise(function (resolve, reject) {
    request({
      method: 'GET',
      url: "https://api.daocloud.io/v1/single_runtime/nodes",
      headers: {
        "Authorization": token
      }
    },
      function (error, response, body) {
        if (body.errno) {
          reject(-99);
        } else {
          var data = JSON.parse(body).nodes[0];
          if (data) {
            ip = data.sandbox_ip_address;
            password = data.sandbox_password;
            resolve(ip + "#" + password);
          }
        }
      });
  });
}
/**
 * 
 * create shadowsocket
 * @param {*} ip ip
 * @param {*} password password
 */
function createShadowsocks(ip, password) {
  return new Promise(function (resolve, reject) {
    var conn = new Client();
    conn.on('ready', function () {
      var tmp = "";
      conn.exec("docker run -d -p 8989:8989 malaohu/ss-with-net-speeder -s 0.0.0.0 -p 8989 -k qfdk -m rc4-md5", function (err, stream) {
        logger.info("[SSH] 连接就绪");
        if (err) {
          logger.info("[SSH] 容器早已建立");
        } else {
          stream.on('close', function (code, signal) {
            logger.info("[SSH] 命令执行完成");
            conn.end();
            resolve("[SSH] 连接关闭");
          }).on('data', function (data) {
            logger.info("[SSH] 执行命令ing");
            tmp += data;
          }).stderr.on('data', function (data) {
            logger.debug(data);
          });
        }
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'ubuntu',
      password: password,
      readyTimeout: 20000
    });
  });
}

function restartBroof() {
  return new Promise(function (resolve, reject) {
    var conn = new Client();
    conn.on('ready', function () {
      var tmp = "";
      conn.exec('service brook-pf restart', function (err, stream) {
        if (err) {
          logger.error("[Broof] 命令失败");
          resolve("[Error] 命令失败");
        } else {
          stream.on('close', function (code, signal) {
            conn.end();
            logger.info("[Broof] 重启成功");
            resolve("[Broof] -> OK");
          }).on('data', function (data) {
            tmp += data;
          }).stderr.on('data', function (data) {
            logger.debug('[Broof] ' + data);
          });
        }
      });
    }).connect({
      host: broof_ssh_host,
      port: 22,
      username: broof_ssh_username,
      password: broof_ssh_password,
      readyTimeout: 120000
    });
  });
}

/**
 * 更新DNS信息
 * @param {*} ip 
 */
function updateDNS(ip) {
  return new Promise(function (resolve, reject) {
    var jsonData = {
      "type": "A",
      "name": cf_dns,
      "content": ip,
      "ttl": 1,
      "proxied": false
    }
    request({
      method: 'PUT',
      url: "https://api.cloudflare.com/client/v4/zones/96e4978ce217656f4f344935cbce6da6/dns_records/5f811e4c1d2bc0c5562f8267dffd3950",
      headers: {
        "X-Auth-Email": cf_email,
        "X-Auth-Key": cf_key,
        "Content-Type": "application/json"
      },
      json: jsonData
    },
      function (error, response, body) {
        logger.info("[DNS] status: [" + (body.success ? "success" : "false") + "]\n" + "[Info] ip: " + ip);
        resolve("[Info] DNS -> OK");
      });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

Date.prototype.Format = function (fmt) { //author: meizz 
  var o = {
    "M+": this.getMonth() + 1, //月份 
    "d+": this.getDate(), //日 
    "h+": this.getHours(), //小时 
    "m+": this.getMinutes(), //分 
    "s+": this.getSeconds(), //秒 
    "q+": Math.floor((this.getMonth() + 3) / 3), //季度 
    "S": this.getMilliseconds() //毫秒 
  };
  if (/(y+)/.test(fmt)) fmt = fmt.replace(RegExp.$1, (this.getFullYear() + "").substr(4 - RegExp.$1.length));
  for (var k in o)
    if (new RegExp("(" + k + ")").test(fmt)) fmt = fmt.replace(RegExp.$1, (RegExp.$1.length == 1) ? (o[k]) : (("00" + o[k]).substr(("" + o[k]).length)));
  return fmt;
}

module.exports = router;
