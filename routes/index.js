var express = require('express');
var router = express.Router();
var request = require('request');
var Client = require('ssh2').Client;
var conn = new Client();
var conf = require('../conf/config.js');

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
          console.log(error);
        } else {
          node_cluster_id = JSON.parse(body).clusters[0].node_cluster_id;
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
          console.log(error);
        } else {
          stream_room = JSON.parse(body).stream_room;
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
              console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Info] 再次建立Docker主机");
            });
          }
        } else {
          console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Info] 建立Docker主机成功:" + body.node.sandbox_ip_address);
          resolve(body);
        }
      });
  });
}

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
          console.log(JSON.parse(body));
          if (data) {
            ip = data.sandbox_ip_address;
            password = data.sandbox_password;
            resolve(ip + "#" + password);
          }
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
    var data = JSON.parse(body).nodes[0];
    console.log("信息：->" + JSON.parse(body).nodes);
    if (JSON.parse(body).nodes.length == 0) {
      console.log("服务器需要重新建立")
      await createNode();
      await sleep(90000);
    } else {
      ip = data.sandbox_ip_address;
      password = data.sandbox_password;
    }
    await info();
    await createShadowsocks(ip, password);
    await updateDNS(ip);
    await restartBroof();
    res.send("[Info] ssh ubuntu@" + ip + " ->" + password);
  });
});

//执行命令
router.get('/cmd', async function (req, res) {
  if (ip == "") {
    var info = await updateInfo();
    ip = info.split("#")[0];
    password = info.split("#")[1];
  }
  var response = await createShadowsocks(ip, password);
  res.send(response);
});

async function info() {
  var flag = false;
  while (!flag) {
    var info = await updateInfo();
    console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Info] 循环取得信息");
    if (info != -99) {
      flag = true;
    }
  }
}

/**
 * 
 * create shadowsocket
 * @param {*} ip ip
 * @param {*} password password
 */
function createShadowsocks(ip, password) {
  return new Promise(function (resolve, reject) {
    conn.on('ready', function () {
      var tmp = "";
      conn.exec('docker run -d --name ss-with-net-speeder -p 8989:8989 malaohu/ss-with-net-speeder -s 0.0.0.0 -p 8989 -k qfdk -m rc4-md5', function (err, stream) {
        if (err) {
          console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Error] 容器早已建立");
        } else {
          stream.on('close', function (code, signal) {
            conn.end();
            console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Info] 命令执行完成");
            resolve("shadowsocks 服务已建立");
          }).on('data', function (data) {
            console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Info] 执行命令ing");
            tmp += data;
          }).stderr.on('data', function (data) {
          });
        }
      });
    }).connect({
      host: ip,
      port: 22,
      username: 'ubuntu',
      password: password,
      readyTimeout: 120000
    });
  });
}

function restartBroof() {
  return new Promise(function (resolve, reject) {
    conn.on('ready', function () {
      var tmp = "";
      conn.exec('service brook-pf restart', function (err, stream) {
        if (err) {
          console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Error] 命令失败");
          resolve("[Error] 命令失败");
        } else {
          stream.on('close', function (code, signal) {
            conn.end();
            console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Info] Broof重启成功");
            resolve("[Info] Broof -> OK");
          }).on('data', function (data) {
            tmp += data;
          }).stderr.on('data', function (data) {
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
        console.log(new Date().Format("yyyy-MM-dd hh:mm:ss") + " [Info] DNS status: [" + (body.success ? "success" : "false") + "]\n" + "[Info] ip: " + ip);
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
