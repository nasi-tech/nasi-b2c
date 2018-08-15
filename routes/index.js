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
              logger.warn("[Docker]重试创建主机");
            });
          }
        } else {
          logger.info("[Docker]主机创建成功");
          resolve('[Docker]主机创建成功');
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
        logger.warn("[Docker] 主机不存在，需要重新建立");
        await createNode();
        res.send("[Docker] 服务器已建立,开机时间约60s");
      } else {
        logger.info("[SSH] 准备建立shadowsocks");
        var tmp = await updateInfo();
        if (tmp != -99) {
          await createShadowsocks(tmp.split("#")[0], tmp.split("#")[1]);
          await updateDNS(tmp.split("#")[0]);
          await restartBroof();
          res.send("[Info] ssh ubuntu@" + ip + " ->" + password);
        } else {
          res.send("[Info] 服务器信息无更新");
        }
      }
    } else {
      res.send("[Info] 服务器需要重新建立");
    }
  });
});

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
            var newIp = data.sandbox_ip_address;
            password = data.sandbox_password;
            if (ip == newIp) {
              resolve(-99);
            } else {
              ip = newIp;
              logger.info("[Docker] 主机连接信息更新成功");
              resolve(newIp + "#" + password);
            }
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
      var stdout = "";
      var stderr = "";
      var cmd = 'docker run -dt --name ss -p 8989:8989 mritd/shadowsocks -s "-s 0.0.0.0 -p 8989 -m rc4-md5 -k qfdk --fast-open"';
      //docker run --name shadowsocks -d -p 8989:8989 malaohu/ss-with-net-speeder -s 0.0.0.0 -p 8989 -k qfdk -m rc4-md5
      conn.exec(cmd, function (err, stream) {
        logger.info("[SSH] 连接就绪");
        if (err) {
          logger.error("[SSH] 出现问题");
          resolve(-99);
        } else {
          stream.on('close', function (code, signal) {
            logger.info("[SSH] 命令完成&关闭SSH连接");
            conn.end();
          }).on('data', function (data) {
            logger.info("[SSH] 执行命令ing...");
            stdout += data;
            logger.info('[SSH] ' + stdout);
            resolve(stdout);
          }).stderr.on('data', function (data) {
            stderr += data;
            if (stderr.indexOf('already') != -1) {
              logger.warn("[SSH] shadowsocks 容器已经存在");
              resolve("[SSH] shadowsocks 容器已经存在");
            } else {
              logger.debug(stderr);
            }
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
          resolve("[Broof] 命令失败");
        } else {
          stream.on('close', function (code, signal) {
            conn.end();
            logger.info("[Broof] 重启成功");
            resolve("[Broof] -> OK");
          }).on('data', function (data) {
            tmp += data;
          }).stderr.on('data', function (data) {
            tmp += data;
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
        logger.info("[DNS status]: " + (body.success ? "success" : "false") + "\n[New ip]: " + ip);
        resolve("[Info] DNS -> OK");
      });
  });
}

router.get('/cmd', async function (req, res) {
  res.send(await createShadowsocks());
})

module.exports = router;
