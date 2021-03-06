const path = require('path')
const fs = require('fs')
const axios = require('axios')
const ora = require('ora')
const Inquirer = require('inquirer')
const { promisify } = require('util') // 可以把基于回调的异步api转为promise的
let downloadGitRepo = require('download-git-repo')
let ncp = require('ncp')
const MetalSmith = require('metalsmith') // 遍历文件夹，找需不需要渲染
let { render } = require('consolidate').ejs // consolidate统一了所有的模板引擎
const { downloadDirectory } = require('./constants.js')

// 将基于回调的api转为支持promise的api
downloadGitRepo = promisify(downloadGitRepo)
ncp = promisify(ncp)
render = promisify(render)

// create的所有逻辑
// 拉取你自己的所有项目列出来，让用户选，安装哪个项目
// 文档地址https://developer.github.com/v3/

// api文档使用方式：
// 1.要查询仓库(repositories)，搜索repositories点击右边的导航
// 2.我们的模板都放在hxin-cli的组织里，搜索org:  GET /orgs/:org/repos
// 于是 https://api.github.com/orgs/hxin-cli/repos 便可以拿到hxin-cli下的所有仓库；

// /repos/:org/:repo/tags 取仓库对应的的版本号(tag)列表
// 如https://api.github.com/repos/hxin-cli/react-simple-template/tags
// 关于tag的操作：https://www.jianshu.com/p/cdd80dd15593

// 选完后，显示所有的版本号
// 可能还需要用户配置一些数据  来结合渲染我的项目

// 1）获取项目列表
const fetchRepoLis = async () => {
  const { data } = await axios.get('https://api.github.com/orgs/hxin-cli/repos')
  return data
}

// 2）获取tag列表
const fetchTagLis = async (repo) => {
  const { data } = await axios.get(`https://api.github.com/repos/hxin-cli/${repo}/tags`)
  return data
}

const downloadRepo = async (repo, tag) => {
  let api = `hxin-cli/${repo}`
  if (tag) {
    api += `#${tag}`
  }
  const dest = `${downloadDirectory}/${repo}` // 下载的最终目录
  await downloadGitRepo(api, dest)
  return dest
}

// 封装loading效果
const waitFnLoading = (fn, message) => async (...args) => {
  const spinner = ora(message)
  spinner.start()
  const result = await fn(...args)
  spinner.succeed()
  return result
}

module.exports = async (projectName) => {
  console.log('create', projectName)
  // 1）获取可选仓库列表
  // const spinner = ora('fetching templates ....')
  // spinner.start()
  // let repoList = await fetchRepoLis()
  // spinner.succeed()
  let repoList = await waitFnLoading(fetchRepoLis, 'fetching templates ....')()
  repoList = repoList.map((item) => item.name)
  // 在获取之前 显示loading 获取完成后关闭loading
  // 获取成功后选择模板 使用inquirer

  const { repo } = await Inquirer.prompt({
    name: 'repo', // 获取选择后的结果的key，就是上面取的时候的'repo'
    type: 'list', // 用户输入形式，list代表列表选择
    choices: repoList, // 选项
    message: 'please choose a template to create project',
  })

  // 2）通过选择的项目，获取版本号
  let tagList = await waitFnLoading(fetchTagLis, 'fetching templates ....')(repo)
  tagList = tagList.map((item) => item.name)
  const { tag } = await Inquirer.prompt({
    name: 'tag', // 获取选择后的结果的key，就是上面取的时候的'repo'
    type: 'list', // 用户输入形式，list代表列表选择
    choices: tagList, // 选项
    message: 'please choose version',
  })
  console.log(repo, tag)
  // 下载模板
  // 3）把模板放到一个临时目录里 存好，以备后期使用
  const templatePath = await waitFnLoading(downloadRepo, 'downloading template ....')(repo, tag)
  console.log(templatePath)

  // 拿到源模板文件后的两种操作
  // 1.拿到了下载的目录，直接拷贝到当前的目录下即可  ncp
  // 2.复杂的需要模板渲染 渲染后再拷贝

  // 4）拷贝操作
  // 简单模板 把template下的文件拷贝到执行命令的目录下的projectName中

  if (!fs.existsSync(path.join(templatePath, 'ask.js'))) {
    // 如果ask.js文件不存在，是简单模板直接拷贝
    await ncp(templatePath, path.resolve(projectName))
  } else {
    // 复杂的模板
    // 把git上的项目下载下来，如果有ask文件(自己约定)，就是一个复杂的模板，我们需要用户选择，选择后编译模板
    // ask.js导出一个数组，形式就是prompt接收的数组参数形式
    // metalsmith 只要是模板编译，都需要这个模块，包括vue-cli和create-react-app 用法可以看官方github上的example目录
    console.log('复杂模板')
    // 1) 让用户填信息去渲染模板
    // metalsmith 只要是模板编译，都需要这个模块，包括vue-cli和create-react-app
    // metalsmith不支持使用promisify转换，这里手动放到promise中去
    await new Promise((resolve, reject) => {
      MetalSmith(__dirname)
        // 如果传入路径，默认会遍历当前路径下的src文件夹,
        // 当传了source后，会去查找source下的文件，这个__dirname传的就没用了，但是内部会校验，还必须得传
        .source(templatePath)
        .destination(path.resolve(projectName)) // 拷贝
        .use(async (files, metal, done) => {
          // use是中间件
          const args = require(path.join(templatePath, 'ask.js'))
          const result = await Inquirer.prompt(args)
          const meta = metal.metadata() // 这个函数返回的meta可以传给下一级中间件的
          Object.assign(meta, result) // 通过metal将用户选择的结果传给下一个中间件
          delete files['ask.js']
          done()
        })
        .use((files, metal, done) => {
          // files是遍历到的所有的文件
          const userData = metal.metadata() // 取出上一步传过来的信息
          // file = {
          //   'src/index.js': {
          //     contents: Buffer...
          //   }
          // }
          Reflect.ownKeys(files).forEach(async (fileName) => {
            if (fileName.includes('js') || fileName.includes('json')) {
              // 只有js和json会有模板引擎
              // contents是二进制的Buffer，因为走到这里的是js或者json，所以一定可以转为字符串
              let content = files[fileName].contents.toString() // 文件的内容
              if (content.includes('<%')) {
                content = await render(content, userData) // 渲染模板引擎
                files[fileName].contents = Buffer.from(content) // 替换源文件
              }
            }
          })
          done()
        })
        .build((err) => {
          // 调用build才开始执行 相当于start
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
    })
  }
}
