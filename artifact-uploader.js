'use strict';

const path = require( 'path' );
const fs = require( 'fs' );
const minio = require( 'minio' );
const glob = require( 'glob' );
const crypto = require( 'crypto' );
const filesize = require( 'filesize' );
const mime = require( 'mime-types' );

const settings = require( 'drone-env-parser' ).parseEnvs( {
    defaults: {
        bucketname: 'artifacts',
        usessl: true,
        port: 9000,
        version: {
            type: 'env',
            variable: 'DRONE_SEMVER',
            scriptPath: './version.js',
            jsonPath: './version.json'
        },
        glob: {},
        mimetypes: {}
    }
} );

function run() {
    let minioClient = new minio.Client( {
        endPoint: settings.endpoint,
        port: settings.port,
        useSSL: settings.usessl,
        accessKey: settings.accesskey,
        secretKey: settings.secretkey
    } );

    let artifactId = settings.artifactid;
    let version = getVersion();

    let files = glob.sync( settings.source, settings.glob || {} ); // https://www.npmjs.com/package/glob#options

    minioClient.statObject( settings.bucketname, `meta/${artifactId}.json` ).then( () => {

    } ).catch( error => {
        if ( error.message.toLowerCase() === 'not found' ) {

            let artifactMetaData = {
                id: artifactId,
                name: process.env.DRONE_REPO_NAME,
                git: {
                    base: process.env.DRONE_REPO_LINK
                }
            };
            minioClient.putObject( settings.bucketname, `meta/${artifactId}.json`, Buffer.from( JSON.stringify( artifactMetaData ), 'utf8' ), {
                'Content-Type': 'application/json'
            } ).then( () => {

            } );
        } else {
            console.error( error );
            process.exit( 1 );
        }
    } );


    Promise.all( files.map( file => {
        return new Promise( ( resolve, reject ) => {
            Promise.all( [
                new Promise( ( resolve, reject ) => {
                    fs.stat( file, ( err, stats ) => {
                        if ( err ) {
                            reject( err );
                        } else {
                            resolve( stats )
                        }
                    } );
                } ), new Promise( ( resolve, reject ) => {
                    let stream = fs.createReadStream( file );
                    let hash = crypto.createHash( 'sha512' );
                    stream.on( 'readable', () => {
                        let data = stream.read();
                        if ( data ) {
                            hash.update( data );
                        } else {
                            let digested = hash.digest( 'hex' );

                            resolve( digested );
                        }
                    } );
                    stream.on( 'error', reject );
                } )
            ] ).then( data => {
                let metaData = {
                    'Content-Type': getContentType( path.extname( file ) )
                };
                let fileName = path.basename( file );
                let objectName = `files/${artifactId}/${version}/${fileName}`;

                minioClient.fPutObject( settings.bucketname, objectName, file, metaData ).then( () => {

                    resolve( {
                        size: filesize( data[ 0 ].size ),
                        hash: data[ 1 ],
                        fileName,
                        objectName,
                        originalPath: file
                    } );
                } ).catch( reject );
            } ).catch( reject );
        } );
    } ) ).then( ( files ) => {

        let buildMetaData = {
            version,
            date: new Date().toISOString(),
            commit: process.env.DRONE_COMMIT_SHA,
            files: files.map( file => {
                return {
                    name: file.fileName,
                    download: `${file.objectName}`,
                    size: file.size,
                    hash: file.hash,
                    originalPath: file.originalPath
                };
            } )
        };
        minioClient.putObject( settings.bucketname, `meta/${artifactId}/${version}.json`, Buffer.from( JSON.stringify( buildMetaData ), 'utf8' ), {
            'Content-Type': 'application/json'
        } ).then( () => {

        } ).catch( ( err ) => {
            console.error( err );
        } );
    } ).catch( ( err ) => {
        console.error( err );
    } );
}

function getVersion() {
    switch ( settings.version.type.toLowerCase() ) {
        case 'env':
            return process.env[ settings.version.variable ];
        case 'script':
            return require( path.join( process.cwd(), settings.version.scriptPath ) ).version;
        case 'json':
            return require( path.join( process.cwd(), settings.version.jsonPath ) ).version;
        default:
            console.error( 'Unknown version type ' + settings.version.type );
            process.exit( 1 );
            break;
    }
}

function getContentType( extension ) {
    extension = extension.toLowerCase();
    if ( settings.mimetypes[ extension ] ) {
        return settings.mimetypes[ extension ];
    }
    return mime.contentType( extension );
}

module.exports.run = run;